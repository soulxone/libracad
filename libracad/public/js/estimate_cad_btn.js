/**
 * estimate_cad_btn.js
 * Injected into Corrugated Estimate form via doctype_js hook.
 * Adds "Create Die Layout" or "Edit Die Layout" button.
 */
frappe.ui.form.on("Corrugated Estimate", {
    refresh: function (frm) {
        if (frm.is_new()) return;

        // Check if a Die Layout already exists for this estimate
        frappe.call({
            method: "libracad.api.get_die_layout_for_estimate",
            args: { estimate_name: frm.doc.name },
            callback: function (r) {
                if (r.message) {
                    // Layout exists — show "Edit Die Layout" button
                    frm.add_custom_button(
                        __("Edit Die Layout"),
                        function () {
                            frappe.set_route("die-layout-editor", {
                                layout: r.message,
                            });
                        },
                        __("LibraCAD")
                    );

                    // Also add a quick link to the Die Layout form
                    frm.add_custom_button(
                        __("View Die Layout"),
                        function () {
                            frappe.set_route("Form", "Die Layout", r.message);
                        },
                        __("LibraCAD")
                    );
                } else {
                    // No layout — show "Create Die Layout" button
                    frm.add_custom_button(
                        __("Create Die Layout"),
                        function () {
                            frappe.call({
                                method: "libracad.api.create_die_layout_from_estimate",
                                args: { estimate_name: frm.doc.name },
                                freeze: true,
                                freeze_message: __("Creating Die Layout..."),
                                callback: function (r) {
                                    if (r.message) {
                                        frappe.msgprint(
                                            __("Die Layout {0} created.", [r.message])
                                        );
                                        // Open the editor
                                        frappe.set_route("die-layout-editor", {
                                            layout: r.message,
                                        });
                                    }
                                },
                            });
                        },
                        __("LibraCAD")
                    );
                }
            },
        });
    },
});
