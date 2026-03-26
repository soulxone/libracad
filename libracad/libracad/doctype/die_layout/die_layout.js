frappe.ui.form.on("Die Layout", {
    refresh: function (frm) {
        // "Open Editor" button — routes to die-layout-editor page
        if (!frm.is_new()) {
            frm.add_custom_button(__("Open Editor"), function () {
                frappe.set_route("die-layout-editor", { layout: frm.doc.name });
            }, __("Actions"));

            // "Generate DXF" button
            frm.add_custom_button(__("Generate DXF"), function () {
                frappe.call({
                    method: "libracad.api.export_dxf",
                    args: { layout_name: frm.doc.name },
                    freeze: true,
                    freeze_message: __("Generating DXF..."),
                    callback: function (r) {
                        if (r.message) {
                            frappe.msgprint(__("DXF file generated and attached."));
                            frm.reload_doc();
                        }
                    },
                });
            }, __("Actions"));

            // Status workflow buttons
            if (frm.doc.status === "Draft") {
                frm.add_custom_button(__("Submit for Review"), function () {
                    frm.set_value("status", "In Review");
                    frm.save();
                }, __("Status"));
            }
            if (frm.doc.status === "In Review") {
                frm.add_custom_button(__("Approve"), function () {
                    frm.set_value("status", "Approved");
                    frm.save();
                }, __("Status"));
            }
            if (frm.doc.status === "Approved") {
                frm.add_custom_button(__("Mark Sent to Die Maker"), function () {
                    frm.set_value("status", "Sent to Die Maker");
                    frm.save();
                }, __("Status"));
            }
        }
    },

    corrugated_estimate: function (frm) {
        // When estimate changes, clear and re-fetch specification fields
        if (frm.doc.corrugated_estimate) {
            frappe.call({
                method: "libracad.api.get_estimate_data",
                args: { estimate_name: frm.doc.corrugated_estimate },
                callback: function (r) {
                    if (r.message) {
                        var d = r.message;
                        frm.set_value("box_style", d.box_style);
                        frm.set_value("flute_type", d.flute_type);
                        frm.set_value("length_inside", d.length_inside);
                        frm.set_value("width_inside", d.width_inside);
                        frm.set_value("depth_inside", d.depth_inside);
                        frm.set_value("blank_length", d.blank_length);
                        frm.set_value("blank_width", d.blank_width);
                        // Auto-set layout name if empty
                        if (!frm.doc.layout_name) {
                            frm.set_value(
                                "layout_name",
                                d.box_style + " " + d.length_inside + "x" + d.width_inside + "x" + d.depth_inside
                            );
                        }
                    }
                },
            });
        }
    },
});
