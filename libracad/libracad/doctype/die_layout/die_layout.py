import frappe
from frappe.model.document import Document


class DieLayout(Document):
    def before_save(self):
        self._fetch_estimate_data()

    def _fetch_estimate_data(self):
        """Pull box specification fields from the linked Corrugated Estimate."""
        if not self.corrugated_estimate:
            return

        est = frappe.get_doc("Corrugated Estimate", self.corrugated_estimate)

        self.box_style = est.box_style
        self.flute_type = est.flute_type
        self.length_inside = est.length_inside
        self.width_inside = est.width_inside
        self.depth_inside = est.depth_inside
        self.blank_length = est.blank_length
        self.blank_width = est.blank_width

    def on_update(self):
        """Keep the Corrugated Estimate's die_layout_link field in sync."""
        if self.corrugated_estimate:
            # Update the custom field on the estimate (if it exists)
            meta = frappe.get_meta("Corrugated Estimate")
            if meta.has_field("die_layout_link"):
                frappe.db.set_value(
                    "Corrugated Estimate",
                    self.corrugated_estimate,
                    "die_layout_link",
                    self.name,
                    update_modified=False,
                )
