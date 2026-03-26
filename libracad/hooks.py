app_name = "libracad"
app_title = "LibraCAD"
app_publisher = "Welchwyse"
app_description = "Web-based 2D CAD for corrugated die layout creation, linked to Corrugated Estimating"
app_email = "admin@welchwyse.com"
app_license = "MIT"
app_version = "0.1.0"

# ── JS includes ──────────────────────────────────────────────────────────────
# app_include_js = "/assets/libracad/js/libracad.bundle.js"

# ── DocType JS overrides ─────────────────────────────────────────────────────
# Inject "Create/Edit Die Layout" button into Corrugated Estimate form
doctype_js = {
    "Corrugated Estimate": "public/js/estimate_cad_btn.js",
}

# ── Fixtures ─────────────────────────────────────────────────────────────────
fixtures = [
    # LibraCAD Settings singleton with sensible defaults
    {
        "doctype": "LibraCAD Settings",
        "filters": [],
    },
    # Custom Field on Corrugated Estimate to link back to Die Layout
    {
        "doctype": "Custom Field",
        "filters": [
            ["name", "in", [
                "Corrugated Estimate-die_layout_link",
            ]]
        ],
    },
    # Workspace
    {
        "doctype": "Workspace",
        "filters": [["name", "in", ["LibraCAD"]]],
    },
]
