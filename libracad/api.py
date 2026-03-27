import frappe
import json


@frappe.whitelist()
def get_estimate_data(estimate_name):
    """Return box specification data from a Corrugated Estimate."""
    est = frappe.get_doc("Corrugated Estimate", estimate_name)
    return {
        "box_style": est.box_style,
        "flute_type": est.flute_type,
        "length_inside": est.length_inside,
        "width_inside": est.width_inside,
        "depth_inside": est.depth_inside,
        "blank_length": est.blank_length,
        "blank_width": est.blank_width,
        "wall_type": est.wall_type,
        "customer": est.customer,
        "estimate_no": est.estimate_no,
    }


@frappe.whitelist()
def get_die_layout_for_estimate(estimate_name):
    """Check if a Die Layout already exists for the given estimate.
    Returns the layout name or None.
    """
    layout = frappe.db.get_value(
        "Die Layout",
        {"corrugated_estimate": estimate_name},
        "name",
    )
    return layout


@frappe.whitelist()
def create_die_layout_from_estimate(estimate_name):
    """Create a new Die Layout linked to the given Corrugated Estimate.
    Returns the new Die Layout name.
    """
    # Check if one already exists
    existing = get_die_layout_for_estimate(estimate_name)
    if existing:
        return existing

    est = frappe.get_doc("Corrugated Estimate", estimate_name)

    layout_name = "{style} {L}x{W}x{D}".format(
        style=est.box_style or "Box",
        L=est.length_inside or 0,
        W=est.width_inside or 0,
        D=est.depth_inside or 0,
    )

    doc = frappe.get_doc({
        "doctype": "Die Layout",
        "layout_name": layout_name,
        "corrugated_estimate": estimate_name,
        "status": "Draft",
    })
    doc.insert(ignore_permissions=True)
    frappe.db.commit()

    return doc.name


@frappe.whitelist()
def save_canvas(layout_name, canvas_json):
    """Save the Fabric.js canvas JSON to the Die Layout document."""
    doc = frappe.get_doc("Die Layout", layout_name)
    doc.canvas_json = canvas_json
    doc.canvas_version = (doc.canvas_version or 0) + 1
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    return {
        "name": doc.name,
        "canvas_version": doc.canvas_version,
    }


@frappe.whitelist()
def load_canvas(layout_name):
    """Load full Die Layout data including canvas JSON and estimate dimensions."""
    doc = frappe.get_doc("Die Layout", layout_name)

    # Also get caliper from flute type for parametric generation
    caliper_in = 0
    if doc.flute_type:
        caliper_in = frappe.db.get_value(
            "Corrugated Flute", doc.flute_type, "thickness_in"
        ) or 0

    return {
        "name": doc.name,
        "layout_name": doc.layout_name,
        "status": doc.status,
        "corrugated_estimate": doc.corrugated_estimate,
        "box_style": doc.box_style,
        "flute_type": doc.flute_type,
        "length_inside": doc.length_inside,
        "width_inside": doc.width_inside,
        "depth_inside": doc.depth_inside,
        "blank_length": doc.blank_length,
        "blank_width": doc.blank_width,
        "caliper_in": caliper_in,
        "canvas_json": doc.canvas_json,
        "canvas_version": doc.canvas_version,
    }


@frappe.whitelist()
def get_nesting_layout(estimate_name, machine_id=None):
    """Calculate nesting layout using corrugated_estimating's layout engine.

    Returns outs, waste %, positions for SVG rendering, and machine comparison.
    """
    from corrugated_estimating.corrugated_estimating.layout import (
        calculate_die_layout,
        calculate_layout_for_all_machines,
    )

    est = frappe.get_doc("Corrugated Estimate", estimate_name)
    blank_l = est.blank_length or 0
    blank_w = est.blank_width or 0

    if blank_l <= 0 or blank_w <= 0:
        frappe.throw("Blank dimensions not calculated on this estimate.")

    layout = calculate_die_layout(blank_l, blank_w, machine_id=machine_id)

    all_machines = []
    try:
        all_machines = calculate_layout_for_all_machines(blank_l, blank_w)
    except Exception:
        pass

    return {
        "layout": layout,
        "all_machines": all_machines,
        "estimate": {
            "name": est.name,
            "box_style": est.box_style,
            "length_inside": est.length_inside,
            "width_inside": est.width_inside,
            "depth_inside": est.depth_inside,
            "blank_length": blank_l,
            "blank_width": blank_w,
            "flute_type": est.flute_type,
        },
    }


@frappe.whitelist()
def export_dxf(layout_name):
    """Generate a DXF file from the canvas JSON and attach to the Die Layout.

    Uses ezdxf (available from corrugated_estimating dependency).
    Returns the file URL on success.
    """
    doc = frappe.get_doc("Die Layout", layout_name)

    if not doc.canvas_json:
        frappe.throw("No canvas data to export. Open the editor and draw first.")

    canvas_data = json.loads(doc.canvas_json)
    objects = canvas_data.get("objects", [])

    if not objects:
        frappe.throw("Canvas is empty. Nothing to export.")

    try:
        import ezdxf
    except ImportError:
        frappe.throw("ezdxf is not installed. Install corrugated_estimating first.")

    dwg = ezdxf.new("R2010")
    msp = dwg.modelspace()

    # Set up layers matching cad_generator.py conventions
    dwg.layers.add("CUT", color=1)       # Red
    dwg.layers.add("SCORE", color=5)     # Blue
    dwg.layers.add("CREASE", color=4)    # Cyan
    dwg.layers.add("DIMENSION", color=3) # Green
    dwg.layers.add("ANNOTATION", color=7)  # White/default
    dwg.layers.add("TITLE", color=7)

    # Convert Fabric.js objects to DXF entities
    for obj in objects:
        layer = obj.get("cadLayer", "CUT")
        obj_type = obj.get("type", "")

        if obj_type == "line":
            msp.add_line(
                (obj.get("x1", 0), -obj.get("y1", 0)),
                (obj.get("x2", 0), -obj.get("y2", 0)),
                dxfattribs={"layer": layer},
            )
        elif obj_type == "rect":
            x = obj.get("left", 0)
            y = -obj.get("top", 0)
            w = obj.get("width", 0) * obj.get("scaleX", 1)
            h = obj.get("height", 0) * obj.get("scaleY", 1)
            points = [(x, y), (x + w, y), (x + w, y - h), (x, y - h), (x, y)]
            msp.add_lwpolyline(points, dxfattribs={"layer": layer})
        elif obj_type == "circle":
            cx = obj.get("left", 0) + obj.get("radius", 0)
            cy = -(obj.get("top", 0) + obj.get("radius", 0))
            msp.add_circle(
                (cx, cy), obj.get("radius", 0),
                dxfattribs={"layer": layer},
            )
        elif obj_type in ("i-text", "text", "textbox"):
            msp.add_text(
                obj.get("text", ""),
                dxfattribs={
                    "layer": layer,
                    "height": obj.get("fontSize", 12) * 0.1,
                    "insert": (obj.get("left", 0), -obj.get("top", 0)),
                },
            )
        elif obj_type == "path":
            # Paths are complex — export as polyline approximation
            path_data = obj.get("path", [])
            points = []
            for cmd in path_data:
                if len(cmd) >= 3 and cmd[0] in ("M", "L"):
                    points.append((cmd[1], -cmd[2]))
            if len(points) >= 2:
                msp.add_lwpolyline(points, dxfattribs={"layer": layer})

    # Save to temp file
    import tempfile
    import os
    tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False)
    tmp_path = tmp.name
    tmp.close()
    dwg.saveas(tmp_path)

    # Read and attach to doctype
    with open(tmp_path, "rb") as f:
        file_data = f.read()

    filename = "DL-{name}.dxf".format(name=doc.name)
    file_doc = frappe.get_doc({
        "doctype": "File",
        "file_name": filename,
        "content": file_data,
        "attached_to_doctype": "Die Layout",
        "attached_to_name": doc.name,
        "is_private": 1,
    })
    file_doc.save(ignore_permissions=True)

    # Update die_layout record
    doc.dxf_file = file_doc.file_url
    doc.save(ignore_permissions=True)
    frappe.db.commit()

    # Clean up temp file
    os.unlink(tmp_path)

    return file_doc.file_url
