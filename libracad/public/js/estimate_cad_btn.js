/**
 * estimate_cad_btn.js
 * Injected into Corrugated Estimate form via doctype_js hook.
 * Adds "Edit Die Layout" / "View Die Layout" buttons under LibraCAD group.
 */
frappe.ui.form.on("Corrugated Estimate", {
    refresh: function (frm) {
        if (frm.is_new()) return;

        // Always show "Edit Die Layout" — the editor handles create-if-missing
        frm.add_custom_button(
            __("Edit Die Layout"),
            function () {
                frappe.set_route("die-layout-editor", {
                    estimate: frm.doc.name,
                });
            },
            __("LibraCAD")
        );

        // Check if a Die Layout already exists for the quick-view link
        frappe.call({
            method: "libracad.api.get_die_layout_for_estimate",
            args: { estimate_name: frm.doc.name },
            callback: function (r) {
                if (r.message) {
                    frm.add_custom_button(
                        __("View Die Layout"),
                        function () {
                            frappe.set_route("Form", "Die Layout", r.message);
                        },
                        __("LibraCAD")
                    );
                }
            },
        });
    },
});
