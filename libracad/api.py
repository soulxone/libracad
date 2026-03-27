import frappe
import json
import os
import tempfile


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
        "box_style": est.box_style,
        "flute_type": est.flute_type,
        "length_inside": est.length_inside,
        "width_inside": est.width_inside,
        "depth_inside": est.depth_inside,
        "blank_length": est.blank_length,
        "blank_width": est.blank_width,
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

    # If Die Layout is missing box dims but has a linked estimate, pull from estimate
    box_style = doc.box_style
    flute_type = doc.flute_type
    length_inside = doc.length_inside
    width_inside = doc.width_inside
    depth_inside = doc.depth_inside
    blank_length = doc.blank_length
    blank_width = doc.blank_width

    if doc.corrugated_estimate and not box_style:
        try:
            est = frappe.get_doc("Corrugated Estimate", doc.corrugated_estimate)
            box_style = est.box_style
            flute_type = est.flute_type
            length_inside = est.length_inside
            width_inside = est.width_inside
            depth_inside = est.depth_inside
            blank_length = est.blank_length
            blank_width = est.blank_width
            # Backfill the Die Layout record
            doc.box_style = box_style
            doc.flute_type = flute_type
            doc.length_inside = length_inside
            doc.width_inside = width_inside
            doc.depth_inside = depth_inside
            doc.blank_length = blank_length
            doc.blank_width = blank_width
            doc.save(ignore_permissions=True)
            frappe.db.commit()
        except Exception:
            pass

    # Also get caliper from flute type for parametric generation
    caliper_in = 0
    if flute_type:
        caliper_in = frappe.db.get_value(
            "Corrugated Flute", flute_type, "thickness_in"
        ) or 0

    return {
        "name": doc.name,
        "layout_name": doc.layout_name,
        "status": doc.status,
        "corrugated_estimate": doc.corrugated_estimate,
        "box_style": box_style,
        "flute_type": flute_type,
        "length_inside": length_inside,
        "width_inside": width_inside,
        "depth_inside": depth_inside,
        "blank_length": blank_length,
        "blank_width": blank_width,
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


# ═══════════════════════════════════════════════════════════════════════════
#  DXF IMPORT — Parse DXF file and create Estimate + Die Layout
# ═══════════════════════════════════════════════════════════════════════════

LAYER_COLORS = {
    "CUT": "#FF0000", "SCORE": "#0000FF", "CREASE": "#00CCCC",
    "DIMENSION": "#00AA00", "ANNOTATION": "#888888", "TITLE": "#888888",
}
LAYER_WIDTHS = {"CUT": 2, "SCORE": 2, "CREASE": 1.5, "DIMENSION": 1, "ANNOTATION": 1}
LAYER_DASH = {"SCORE": [10, 5], "CREASE": [5, 5]}
PIXELS_PER_UNIT = 10


@frappe.whitelist()
def import_dxf(file_url):
    """Import a DXF file: parse geometry, create Estimate + Die Layout with canvas.

    Args:
        file_url: Frappe file URL (e.g. /private/files/box.dxf)

    Returns dict with estimate_name, layout_name, dimensions, detected style.
    """
    try:
        import ezdxf
    except ImportError:
        frappe.throw("ezdxf not installed.")

    # Read file content from Frappe
    file_doc = frappe.get_doc("File", {"file_url": file_url})
    file_content = file_doc.get_content()

    # Write to temp for ezdxf
    tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False)
    tmp.write(file_content if isinstance(file_content, bytes) else file_content.encode())
    tmp.close()

    try:
        doc = ezdxf.readfile(tmp.name)
    except Exception as e:
        os.unlink(tmp.name)
        frappe.throw(f"Failed to parse DXF: {e}")

    msp = doc.modelspace()

    # Extract layers present
    layers_found = list(set(e.dxf.layer for e in msp))

    # Extract blank dimensions from CUT layer bounding box
    blank_length, blank_width = _extract_blank_dims(msp)

    # Detect box style
    detected_style = _detect_box_style(msp, layers_found)

    # Convert all entities to Fabric.js canvas JSON
    canvas_json = _dxf_to_fabric_canvas(msp, blank_width)

    # Count entities
    entity_counts = {}
    for e in msp:
        t = e.dxftype()
        entity_counts[t] = entity_counts.get(t, 0) + 1

    os.unlink(tmp.name)

    # Create Corrugated Estimate
    est = frappe.get_doc({
        "doctype": "Corrugated Estimate",
        "box_style": detected_style if detected_style != "UNKNOWN" else "DIE-CUT",
        "blank_length": blank_length,
        "blank_width": blank_width,
        "wall_type": "Single Wall",
        "flute_type": "C",
        "status": "Draft",
    })
    est.insert(ignore_permissions=True)

    # Create Die Layout with canvas
    layout = frappe.get_doc({
        "doctype": "Die Layout",
        "layout_name": f"Imported {detected_style} {blank_length:.1f}x{blank_width:.1f}",
        "corrugated_estimate": est.name,
        "status": "Draft",
        "canvas_json": canvas_json,
        "canvas_version": 1,
    })
    layout.insert(ignore_permissions=True)

    # Attach original DXF to layout
    imported_file = frappe.get_doc({
        "doctype": "File",
        "file_url": file_url,
        "attached_to_doctype": "Die Layout",
        "attached_to_name": layout.name,
    })
    try:
        imported_file.insert(ignore_permissions=True)
    except Exception:
        pass

    frappe.db.commit()

    return {
        "success": True,
        "estimate_name": est.name,
        "layout_name": layout.name,
        "blank_length": round(blank_length, 3),
        "blank_width": round(blank_width, 3),
        "detected_style": detected_style,
        "layers_found": layers_found,
        "entity_counts": entity_counts,
        "total_entities": sum(entity_counts.values()),
    }


def _extract_blank_dims(msp):
    """Extract blank dimensions from CUT layer bounding box."""
    from ezdxf import bbox as ezdxf_bbox

    cut_entities = list(msp.query('*[layer=="CUT"]'))
    if not cut_entities:
        # Fall back to all entities
        cut_entities = list(msp)

    cache = ezdxf_bbox.Cache()
    box = ezdxf_bbox.extents(cut_entities, cache=cache)

    if not box.has_data:
        return 0, 0

    return round(box.size[0], 4), round(box.size[1], 4)


def _detect_box_style(msp, layers):
    """Detect box style from TITLE text or geometry patterns."""
    # Check TITLE/ANNOTATION text first
    for e in msp:
        if e.dxftype() in ("TEXT", "MTEXT") and e.dxf.layer in ("TITLE", "ANNOTATION", "DIMENSION"):
            text = ""
            if e.dxftype() == "TEXT":
                text = e.dxf.text.upper()
            elif e.dxftype() == "MTEXT":
                text = e.text.upper() if hasattr(e, "text") else ""

            for style in ("RSC", "FOL", "HSC", "TRAY", "BLISS", "SFF"):
                if style in text:
                    return style

    # Count score lines to guess style
    v_scores = set()
    for e in msp.query('*[layer=="SCORE"]'):
        if e.dxftype() == "LINE":
            if abs(e.dxf.start[0] - e.dxf.end[0]) < 0.01:  # Vertical
                v_scores.add(round(e.dxf.start[0], 2))

    if len(v_scores) >= 4:
        return "RSC"
    elif len(v_scores) == 3:
        return "FOL"
    elif len(v_scores) == 2:
        return "TRAY"

    return "DIE-CUT"


def _dxf_to_fabric_canvas(msp, blank_height):
    """Convert all DXF entities to Fabric.js canvas JSON."""
    from ezdxf import bbox as ezdxf_bbox

    all_entities = list(msp)
    if not all_entities:
        return json.dumps({"version": "5.3.0", "objects": []})

    cache = ezdxf_bbox.Cache()
    box = ezdxf_bbox.extents(all_entities, cache=cache)
    if not box.has_data:
        return json.dumps({"version": "5.3.0", "objects": []})

    # Y-flip: DXF is Y-up, Fabric is Y-down
    max_y = box.extmax[1]
    min_x = box.extmin[0]
    sc = PIXELS_PER_UNIT

    objects = []
    for e in all_entities:
        layer = e.dxf.layer if hasattr(e.dxf, "layer") else "CUT"
        color = LAYER_COLORS.get(layer, "#888888")
        width = LAYER_WIDTHS.get(layer, 1)
        dash = LAYER_DASH.get(layer)

        try:
            if e.dxftype() == "LINE":
                obj = {
                    "type": "line",
                    "x1": (e.dxf.start[0] - min_x) * sc,
                    "y1": (max_y - e.dxf.start[1]) * sc,
                    "x2": (e.dxf.end[0] - min_x) * sc,
                    "y2": (max_y - e.dxf.end[1]) * sc,
                    "stroke": color,
                    "strokeWidth": width,
                    "selectable": True,
                    "cadLayer": layer,
                    "cadType": "imported",
                }
                if dash:
                    obj["strokeDashArray"] = dash
                objects.append(obj)

            elif e.dxftype() == "LWPOLYLINE":
                pts = list(e.get_points(format="xy"))
                for i in range(len(pts) - 1):
                    obj = {
                        "type": "line",
                        "x1": (pts[i][0] - min_x) * sc,
                        "y1": (max_y - pts[i][1]) * sc,
                        "x2": (pts[i + 1][0] - min_x) * sc,
                        "y2": (max_y - pts[i + 1][1]) * sc,
                        "stroke": color,
                        "strokeWidth": width,
                        "selectable": True,
                        "cadLayer": layer,
                        "cadType": "imported",
                    }
                    if dash:
                        obj["strokeDashArray"] = dash
                    objects.append(obj)
                # Close if closed polyline
                if e.close and len(pts) > 2:
                    obj = {
                        "type": "line",
                        "x1": (pts[-1][0] - min_x) * sc,
                        "y1": (max_y - pts[-1][1]) * sc,
                        "x2": (pts[0][0] - min_x) * sc,
                        "y2": (max_y - pts[0][1]) * sc,
                        "stroke": color,
                        "strokeWidth": width,
                        "selectable": True,
                        "cadLayer": layer,
                        "cadType": "imported",
                    }
                    if dash:
                        obj["strokeDashArray"] = dash
                    objects.append(obj)

            elif e.dxftype() == "CIRCLE":
                cx = (e.dxf.center[0] - min_x) * sc
                cy = (max_y - e.dxf.center[1]) * sc
                r = e.dxf.radius * sc
                objects.append({
                    "type": "circle",
                    "left": cx - r,
                    "top": cy - r,
                    "radius": r,
                    "fill": "transparent",
                    "stroke": color,
                    "strokeWidth": width,
                    "selectable": True,
                    "cadLayer": layer,
                    "cadType": "imported",
                })

            elif e.dxftype() in ("TEXT", "MTEXT"):
                text_str = e.dxf.text if e.dxftype() == "TEXT" else (e.text if hasattr(e, "text") else "")
                if not text_str:
                    continue
                insert = e.dxf.insert if hasattr(e.dxf, "insert") else (0, 0, 0)
                height = e.dxf.height if hasattr(e.dxf, "height") else 0.15
                objects.append({
                    "type": "i-text",
                    "text": text_str,
                    "left": (insert[0] - min_x) * sc,
                    "top": (max_y - insert[1]) * sc,
                    "fontSize": max(height * sc, 8),
                    "fill": color,
                    "fontFamily": "monospace",
                    "selectable": True,
                    "cadLayer": layer,
                    "cadType": "imported",
                })
        except Exception:
            continue  # Skip unparseable entities

    canvas = {
        "version": "5.3.0",
        "objects": objects,
    }
    return json.dumps(canvas)
