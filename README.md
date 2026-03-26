# LibraCAD

Web-based 2D CAD for corrugated die layout creation — Frappe/ERPNext app linked to Corrugated Estimating.

## Features

- Die Layout doctype linked to Corrugated Estimate
- Interactive Fabric.js canvas editor with 10 drawing tools
- Parametric generators for RSC, FOL, HSC box styles
- DXF export via ezdxf
- SVG/PNG client-side export
- 5-layer system matching industry DXF conventions (CUT, SCORE, CREASE, DIMENSION, ANNOTATION)
- Die maker workflow tracking (Draft → Approved → Sent to Die Maker)

## Install

```bash
bench get-app https://github.com/soulxone/libracad
bench --site <site> install-app libracad
bench build --app libracad
```

## License

MIT
