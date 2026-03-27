frappe.pages["die-layout-editor"].on_page_load = function (wrapper) {
    var page = frappe.ui.make_app_page({
        parent: wrapper,
        title: "Die Layout Editor",
        single_column: true,
    });

    $(frappe.render_template("die_layout_editor", {})).appendTo(page.main);

    // Store reference for on_page_show
    wrapper.die_layout_editor = new DieLayoutEditor(wrapper, page);
};

frappe.pages["die-layout-editor"].on_page_show = function (wrapper) {
    if (wrapper.die_layout_editor) {
        wrapper.die_layout_editor.on_show();
    }
};

// ─── Constants ──────────────────────────────────────────────────────────────
var LAYERS = {
    CUT:        { color: "#FF0000", dxfColor: 1, dash: null,     width: 2 },
    SCORE:      { color: "#0000FF", dxfColor: 5, dash: [10, 5],  width: 2 },
    CREASE:     { color: "#00CCCC", dxfColor: 4, dash: [5, 5],   width: 1.5 },
    DIMENSION:  { color: "#00AA00", dxfColor: 3, dash: null,     width: 1 },
    ANNOTATION: { color: "#888888", dxfColor: 7, dash: null,     width: 1 },
};

var JOINT = 1.25;          // Glue tab width (inches) — matches cad_generator.py
var PIXELS_PER_UNIT = 10;  // 10 pixels per inch on canvas

// ─── Main Editor Class ─────────────────────────────────────────────────────
function DieLayoutEditor(wrapper, page) {
    this.wrapper = wrapper;
    this.page = page;
    this.$container = $(wrapper).find(".dle-container");

    this.layoutName = null;
    this.layoutData = null;
    this.canvas = null;
    this.activeTool = "select";
    this.activeLayer = "CUT";
    this.gridVisible = true;
    this.snapEnabled = true;
    this.gridSpacing = 0.25;
    this.undoStack = [];
    this.redoStack = [];
    this.isDirty = false;
    this._drawingState = null;

    this._loadFabric();
}

DieLayoutEditor.prototype._loadFabric = function () {
    var self = this;
    if (typeof fabric !== "undefined") {
        self._init();
        return;
    }
    // Load Fabric.js from CDN
    var script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js";
    script.onload = function () {
        self._init();
    };
    script.onerror = function () {
        frappe.msgprint("Failed to load Fabric.js. Check your internet connection.");
    };
    document.head.appendChild(script);
};

DieLayoutEditor.prototype._init = function () {
    this._setupCanvas();
    this._bindToolbar();
    this._bindTools();
    this._bindLayers();
    this._bindKeyboard();
    this._bindCanvasEvents();
    this._bindTabs();
    this.on_show();
};

// ─── Canvas Setup ───────────────────────────────────────────────────────────
DieLayoutEditor.prototype._setupCanvas = function () {
    var wrap = this.$container.find(".dle-canvas-wrap");
    var w = wrap.width() || 800;
    var h = wrap.height() || 600;

    this.canvas = new fabric.Canvas("dle-canvas", {
        width: w,
        height: h,
        backgroundColor: "#FFFFFF",
        selection: true,
        preserveObjectStacking: true,
    });

    // Resize canvas on window resize
    var self = this;
    $(window).on("resize", frappe.utils.debounce(function () {
        var wrap = self.$container.find(".dle-canvas-wrap");
        self.canvas.setWidth(wrap.width());
        self.canvas.setHeight(wrap.height());
        self.canvas.renderAll();
    }, 200));

    this._drawGrid();
};

// ─── Grid Drawing ───────────────────────────────────────────────────────────
DieLayoutEditor.prototype._drawGrid = function () {
    if (!this.canvas) return;

    // Remove old grid lines
    var objects = this.canvas.getObjects("line");
    for (var i = objects.length - 1; i >= 0; i--) {
        if (objects[i].cadType === "grid") {
            this.canvas.remove(objects[i]);
        }
    }

    if (!this.gridVisible) return;

    var w = this.canvas.getWidth();
    var h = this.canvas.getHeight();
    var step = this.gridSpacing * PIXELS_PER_UNIT;
    var majorStep = step * 4; // Every inch if gridSpacing = 0.25

    // Vertical lines
    for (var x = 0; x < w; x += step) {
        var isMajor = Math.abs(x % majorStep) < 0.5;
        var line = new fabric.Line([x, 0, x, h], {
            stroke: isMajor ? "#CCCCCC" : "#E8E8E8",
            strokeWidth: isMajor ? 0.5 : 0.25,
            selectable: false,
            evented: false,
            cadType: "grid",
            excludeFromExport: true,
        });
        this.canvas.add(line);
        this.canvas.sendToBack(line);
    }

    // Horizontal lines
    for (var y = 0; y < h; y += step) {
        var isMajor = Math.abs(y % majorStep) < 0.5;
        var line = new fabric.Line([0, y, w, y], {
            stroke: isMajor ? "#CCCCCC" : "#E8E8E8",
            strokeWidth: isMajor ? 0.5 : 0.25,
            selectable: false,
            evented: false,
            cadType: "grid",
            excludeFromExport: true,
        });
        this.canvas.add(line);
        this.canvas.sendToBack(line);
    }
};

// ─── Snap to Grid ───────────────────────────────────────────────────────────
DieLayoutEditor.prototype._snap = function (val) {
    if (!this.snapEnabled) return val;
    var step = this.gridSpacing * PIXELS_PER_UNIT;
    return Math.round(val / step) * step;
};

DieLayoutEditor.prototype._toUnits = function (px) {
    return px / PIXELS_PER_UNIT;
};

DieLayoutEditor.prototype._toPixels = function (units) {
    return units * PIXELS_PER_UNIT;
};

// ─── Page Show (load layout from URL params) ────────────────────────────────
DieLayoutEditor.prototype.on_show = function () {
    var params = frappe.utils.get_url_dict ? frappe.route_options : {};
    if (!params) params = {};

    // Try route_options first, then URL query
    var layoutName = params.layout || frappe.utils.get_url_arg("layout");
    var estimateName = params.estimate || frappe.utils.get_url_arg("estimate");

    if (layoutName && layoutName !== this.layoutName) {
        this.layoutName = layoutName;
        this._loadLayout(layoutName);
    } else if (estimateName) {
        // Load from estimate: find or create Die Layout, then load it
        this._loadFromEstimate(estimateName);
    }
    // Clear route_options so they don't persist
    frappe.route_options = null;
};

DieLayoutEditor.prototype._loadFromEstimate = function (estimateName) {
    var self = this;
    frappe.call({
        method: "libracad.api.get_die_layout_for_estimate",
        args: { estimate_name: estimateName },
        callback: function (r) {
            if (r.message) {
                // Layout exists — load it
                self.layoutName = r.message;
                self._loadLayout(r.message);
            } else {
                // Create a new one and load it
                frappe.call({
                    method: "libracad.api.create_die_layout_from_estimate",
                    args: { estimate_name: estimateName },
                    freeze: true,
                    freeze_message: "Creating die layout from estimate...",
                    callback: function (r2) {
                        if (r2.message) {
                            self.layoutName = r2.message;
                            self._loadLayout(r2.message);
                        }
                    },
                });
            }
        },
    });
};

DieLayoutEditor.prototype._loadLayout = function (layoutName) {
    var self = this;
    frappe.call({
        method: "libracad.api.load_canvas",
        args: { layout_name: layoutName },
        freeze: true,
        freeze_message: "Loading die layout...",
        callback: function (r) {
            if (r.message) {
                self.layoutData = r.message;
                self._updateHeader();
                self._updateBoxInfo();

                if (r.message.canvas_json) {
                    self._loadCanvasJSON(r.message.canvas_json);
                } else {
                    // No canvas data yet — auto-generate if setting enabled
                    self._autoGenerate();
                }
                self._saveUndoState();
            }
        },
    });
};

DieLayoutEditor.prototype._updateHeader = function () {
    var d = this.layoutData;
    this.$container.find(".dle-layout-name").text(d.layout_name || "");
    var badge = this.$container.find(".dle-status-badge");
    badge.text(d.status || "Draft");
    var colors = { Draft: "#FFA500", "In Review": "#2196F3", Approved: "#4CAF50", "Sent to Die Maker": "#9C27B0", Archived: "#888" };
    badge.css("background-color", colors[d.status] || "#888");
    badge.css("color", "#fff");
};

DieLayoutEditor.prototype._updateBoxInfo = function () {
    var d = this.layoutData;
    if (!d) return;
    var html = [
        '<div><b>Estimate:</b> <a href="/app/corrugated-estimate/' + d.corrugated_estimate + '">' + d.corrugated_estimate + '</a></div>',
        '<div><b>Style:</b> ' + (d.box_style || "—") + '</div>',
        '<div><b>Dimensions:</b> ' + (d.length_inside || 0) + ' x ' + (d.width_inside || 0) + ' x ' + (d.depth_inside || 0) + '</div>',
        '<div><b>Blank:</b> ' + (d.blank_length || 0) + ' x ' + (d.blank_width || 0) + '</div>',
        '<div><b>Flute:</b> ' + (d.flute_type || "—") + '</div>',
    ].join("");
    this.$container.find(".dle-box-info").html(html);
};

// ─── Canvas JSON I/O ────────────────────────────────────────────────────────
DieLayoutEditor.prototype._loadCanvasJSON = function (jsonStr) {
    var self = this;
    try {
        var data = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
        this.canvas.loadFromJSON(data, function () {
            self._drawGrid();
            self.canvas.renderAll();
        });
    } catch (e) {
        console.error("Failed to load canvas JSON:", e);
    }
};

DieLayoutEditor.prototype._getCanvasJSON = function () {
    // Exclude grid lines from export
    var json = this.canvas.toJSON(["cadLayer", "cadType", "locked"]);
    json.objects = json.objects.filter(function (obj) {
        return obj.cadType !== "grid";
    });
    return JSON.stringify(json);
};

// ─── Undo / Redo ────────────────────────────────────────────────────────────
DieLayoutEditor.prototype._saveUndoState = function () {
    this.undoStack.push(this._getCanvasJSON());
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
};

DieLayoutEditor.prototype._undo = function () {
    if (this.undoStack.length <= 1) return;
    this.redoStack.push(this.undoStack.pop());
    var state = this.undoStack[this.undoStack.length - 1];
    this._loadCanvasJSON(state);
    this.isDirty = true;
};

DieLayoutEditor.prototype._redo = function () {
    if (this.redoStack.length === 0) return;
    var state = this.redoStack.pop();
    this.undoStack.push(state);
    this._loadCanvasJSON(state);
    this.isDirty = true;
};

// ─── Toolbar Bindings ───────────────────────────────────────────────────────
DieLayoutEditor.prototype._bindToolbar = function () {
    var self = this;

    this.$container.find(".dle-btn-save").on("click", function () { self._save(); });
    this.$container.find(".dle-btn-undo").on("click", function () { self._undo(); });
    this.$container.find(".dle-btn-redo").on("click", function () { self._redo(); });

    this.$container.find(".dle-btn-zoom-in").on("click", function () {
        self.canvas.setZoom(self.canvas.getZoom() * 1.2);
        self.canvas.renderAll();
    });
    this.$container.find(".dle-btn-zoom-out").on("click", function () {
        self.canvas.setZoom(self.canvas.getZoom() / 1.2);
        self.canvas.renderAll();
    });
    this.$container.find(".dle-btn-zoom-fit").on("click", function () { self._zoomToFit(); });

    this.$container.find(".dle-btn-grid").on("click", function () {
        self.gridVisible = !self.gridVisible;
        $(this).toggleClass("active", self.gridVisible);
        self._drawGrid();
        self.canvas.renderAll();
    }).addClass("active");

    this.$container.find(".dle-btn-snap").on("click", function () {
        self.snapEnabled = !self.snapEnabled;
        $(this).toggleClass("active", self.snapEnabled);
    }).addClass("active");

    this.$container.find(".dle-btn-autogen").on("click", function () { self._autoGenerate(); });

    // Export buttons
    this.$container.find(".dle-export-dxf").on("click", function () {
        frappe.call({
            method: "libracad.api.export_dxf",
            args: { layout_name: self.layoutName },
            freeze: true,
            freeze_message: "Generating DXF...",
            callback: function (r) {
                if (r.message) {
                    window.open(r.message);
                    frappe.show_alert({ message: "DXF exported!", indicator: "green" });
                }
            },
        });
    });
    this.$container.find(".dle-export-svg").on("click", function () { self._exportSVG(); });

    // Import CAD file button (DXF, SVG, AI, EPS, PDF)
    this.$container.find(".dle-btn-import-dxf").on("click", function () { self._importCAD(); });
    this.$container.find(".dle-export-png").on("click", function () { self._exportPNG(); });
};

// ─── Tool Bindings ──────────────────────────────────────────────────────────
DieLayoutEditor.prototype._bindTools = function () {
    var self = this;
    this.$container.find(".dle-tool").on("click", function () {
        self.$container.find(".dle-tool").removeClass("active");
        $(this).addClass("active");
        self.activeTool = $(this).data("tool");
        self._applyToolMode();
    });
};

DieLayoutEditor.prototype._applyToolMode = function () {
    var isSelect = this.activeTool === "select";
    this.canvas.selection = isSelect;
    this.canvas.forEachObject(function (obj) {
        if (obj.cadType !== "grid") {
            obj.selectable = isSelect;
            obj.evented = isSelect;
        }
    });
    this.canvas.defaultCursor = isSelect ? "default" : "crosshair";
    this.canvas.renderAll();
};

// ─── Layer Bindings ─────────────────────────────────────────────────────────
DieLayoutEditor.prototype._bindLayers = function () {
    var self = this;
    this.$container.find(".dle-layer-toggle").on("change", function () {
        var layer = $(this).data("layer");
        var visible = $(this).is(":checked");
        self.canvas.forEachObject(function (obj) {
            if (obj.cadLayer === layer) {
                obj.visible = visible;
            }
        });
        self.canvas.renderAll();
    });
};

// ─── Keyboard Shortcuts ─────────────────────────────────────────────────────
DieLayoutEditor.prototype._bindKeyboard = function () {
    var self = this;
    $(document).on("keydown", function (e) {
        // Only handle if editor page is visible
        if (!self.$container.is(":visible")) return;

        if (e.ctrlKey || e.metaKey) {
            if (e.key === "s") { e.preventDefault(); self._save(); }
            if (e.key === "z") { e.preventDefault(); self._undo(); }
            if (e.key === "y") { e.preventDefault(); self._redo(); }
        } else {
            if (e.key === "v") self._selectTool("select");
            if (e.key === "l") self._selectTool("line");
            if (e.key === "s" && !e.ctrlKey) self._selectTool("score");
            if (e.key === "d") self._selectTool("dimension");
            if (e.key === "r") self._selectTool("rect");
            if (e.key === "c" && !e.ctrlKey) self._selectTool("circle");
            if (e.key === "g") {
                self.gridVisible = !self.gridVisible;
                self.$container.find(".dle-btn-grid").toggleClass("active", self.gridVisible);
                self._drawGrid();
                self.canvas.renderAll();
            }
            if (e.key === "Delete" || e.key === "Backspace") {
                var active = self.canvas.getActiveObjects();
                if (active.length) {
                    active.forEach(function (obj) {
                        if (obj.cadType !== "grid") self.canvas.remove(obj);
                    });
                    self.canvas.discardActiveObject();
                    self.canvas.renderAll();
                    self._saveUndoState();
                    self.isDirty = true;
                }
            }
            if (e.key === "Escape") {
                self.canvas.discardActiveObject();
                self._selectTool("select");
                self._drawingState = null;
                self.canvas.renderAll();
            }
        }
    });
};

DieLayoutEditor.prototype._selectTool = function (tool) {
    this.activeTool = tool;
    this.$container.find(".dle-tool").removeClass("active");
    this.$container.find('.dle-tool[data-tool="' + tool + '"]').addClass("active");
    this._applyToolMode();
};

// ─── Canvas Mouse Events (Drawing) ─────────────────────────────────────────
DieLayoutEditor.prototype._bindCanvasEvents = function () {
    var self = this;

    // Coordinate readout
    this.canvas.on("mouse:move", function (opt) {
        var pointer = self.canvas.getPointer(opt.e);
        var x = self._toUnits(pointer.x).toFixed(2);
        var y = self._toUnits(pointer.y).toFixed(2);
        self.$container.find(".dle-coords").text("X: " + x + "  Y: " + y);

        // Drawing preview
        if (self._drawingState && self._drawingState.preview) {
            var sx = self._snap(pointer.x);
            var sy = self._snap(pointer.y);
            self._updateDrawingPreview(sx, sy);
        }
    });

    // Mouse down — start drawing
    this.canvas.on("mouse:down", function (opt) {
        if (self.activeTool === "select") return;
        var pointer = self.canvas.getPointer(opt.e);
        var x = self._snap(pointer.x);
        var y = self._snap(pointer.y);
        self._startDrawing(x, y);
    });

    // Mouse up — finish drawing
    this.canvas.on("mouse:up", function (opt) {
        if (self._drawingState && self._drawingState.preview) {
            var pointer = self.canvas.getPointer(opt.e);
            var x = self._snap(pointer.x);
            var y = self._snap(pointer.y);
            self._finishDrawing(x, y);
        }
    });

    // Object modified — track dirty state
    this.canvas.on("object:modified", function () {
        self.isDirty = true;
        self._saveUndoState();
    });

    // Mouse wheel zoom
    this.canvas.on("mouse:wheel", function (opt) {
        var delta = opt.e.deltaY;
        var zoom = self.canvas.getZoom();
        zoom *= 0.999 ** delta;
        if (zoom > 20) zoom = 20;
        if (zoom < 0.1) zoom = 0.1;
        self.canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom);
        opt.e.preventDefault();
        opt.e.stopPropagation();
    });

    // Middle-button pan
    var isPanning = false;
    var lastPosX, lastPosY;
    this.canvas.on("mouse:down", function (opt) {
        if (opt.e.button === 1) { // Middle button
            isPanning = true;
            lastPosX = opt.e.clientX;
            lastPosY = opt.e.clientY;
            self.canvas.selection = false;
        }
    });
    this.canvas.on("mouse:move", function (opt) {
        if (isPanning) {
            var vpt = self.canvas.viewportTransform;
            vpt[4] += opt.e.clientX - lastPosX;
            vpt[5] += opt.e.clientY - lastPosY;
            lastPosX = opt.e.clientX;
            lastPosY = opt.e.clientY;
            self.canvas.requestRenderAll();
        }
    });
    this.canvas.on("mouse:up", function (opt) {
        if (isPanning) {
            isPanning = false;
            self.canvas.selection = self.activeTool === "select";
        }
    });

    // Selection — update properties panel
    this.canvas.on("selection:created", function () { self._updateProperties(); });
    this.canvas.on("selection:updated", function () { self._updateProperties(); });
    this.canvas.on("selection:cleared", function () { self._clearProperties(); });
};

// ─── Drawing: Start / Preview / Finish ──────────────────────────────────────
DieLayoutEditor.prototype._startDrawing = function (x, y) {
    var tool = this.activeTool;
    var layerKey = this._getLayerForTool(tool);
    var layerDef = LAYERS[layerKey];

    if (tool === "line" || tool === "score" || tool === "cut" || tool === "dimension") {
        var line = new fabric.Line([x, y, x, y], {
            stroke: layerDef.color,
            strokeWidth: layerDef.width,
            strokeDashArray: layerDef.dash,
            selectable: false,
            evented: false,
            cadLayer: layerKey,
            cadType: tool,
        });
        this.canvas.add(line);
        this._drawingState = { type: tool, preview: line, startX: x, startY: y };
    } else if (tool === "rect" || tool === "gluetab") {
        var rect = new fabric.Rect({
            left: x, top: y, width: 0, height: 0,
            fill: "transparent",
            stroke: layerDef.color,
            strokeWidth: layerDef.width,
            strokeDashArray: layerDef.dash,
            selectable: false,
            evented: false,
            cadLayer: layerKey,
            cadType: tool,
        });
        this.canvas.add(rect);
        this._drawingState = { type: tool, preview: rect, startX: x, startY: y };
    } else if (tool === "circle") {
        var circle = new fabric.Circle({
            left: x, top: y, radius: 0,
            fill: "transparent",
            stroke: layerDef.color,
            strokeWidth: layerDef.width,
            selectable: false,
            evented: false,
            cadLayer: layerKey,
            cadType: tool,
        });
        this.canvas.add(circle);
        this._drawingState = { type: tool, preview: circle, startX: x, startY: y };
    } else if (tool === "slot") {
        // Slot: vertical cut line, click to place
        var slotH = this._toPixels((this.layoutData && this.layoutData.depth_inside ? this.layoutData.depth_inside / 2 : 2));
        var slotLine = new fabric.Line([x, y - slotH / 2, x, y + slotH / 2], {
            stroke: layerDef.color,
            strokeWidth: layerDef.width,
            selectable: true,
            cadLayer: "CUT",
            cadType: "slot",
        });
        this.canvas.add(slotLine);
        this._saveUndoState();
        this.isDirty = true;
        this._drawingState = null;
    } else if (tool === "handhole") {
        // Standard hand hole: 4" x 1.5" oblong
        var hw = this._toPixels(4);
        var hh = this._toPixels(1.5);
        var r = hh / 2;
        var handhole = new fabric.Rect({
            left: x - hw / 2, top: y - hh / 2,
            width: hw, height: hh, rx: r, ry: r,
            fill: "transparent",
            stroke: layerDef.color,
            strokeWidth: layerDef.width,
            selectable: true,
            cadLayer: "CUT",
            cadType: "handhole",
        });
        this.canvas.add(handhole);
        this._saveUndoState();
        this.isDirty = true;
        this._drawingState = null;
    }
};

DieLayoutEditor.prototype._updateDrawingPreview = function (x, y) {
    var state = this._drawingState;
    if (!state || !state.preview) return;
    var obj = state.preview;

    if (state.type === "line" || state.type === "score" || state.type === "cut" || state.type === "dimension") {
        obj.set({ x2: x, y2: y });
    } else if (state.type === "rect" || state.type === "gluetab") {
        var left = Math.min(state.startX, x);
        var top = Math.min(state.startY, y);
        obj.set({
            left: left, top: top,
            width: Math.abs(x - state.startX),
            height: Math.abs(y - state.startY),
        });
    } else if (state.type === "circle") {
        var radius = Math.sqrt(Math.pow(x - state.startX, 2) + Math.pow(y - state.startY, 2));
        obj.set({ radius: radius });
    }
    obj.setCoords();
    this.canvas.renderAll();
};

DieLayoutEditor.prototype._finishDrawing = function (x, y) {
    var state = this._drawingState;
    if (!state) return;

    var obj = state.preview;

    // For dimension tool, add text label
    if (state.type === "dimension") {
        var dx = x - state.startX;
        var dy = y - state.startY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var distUnits = this._toUnits(dist).toFixed(3);
        var midX = (state.startX + x) / 2;
        var midY = (state.startY + y) / 2;

        var text = new fabric.IText(distUnits + '"', {
            left: midX, top: midY - 15,
            fontSize: 11,
            fill: LAYERS.DIMENSION.color,
            fontFamily: "monospace",
            cadLayer: "DIMENSION",
            cadType: "dimension-text",
        });
        this.canvas.add(text);
    }

    // Make the drawn object selectable now
    obj.set({ selectable: true, evented: true });
    obj.setCoords();

    this._drawingState = null;
    this._saveUndoState();
    this.isDirty = true;
    this.canvas.renderAll();
};

DieLayoutEditor.prototype._getLayerForTool = function (tool) {
    var map = {
        select: "CUT", line: "CUT", cut: "CUT", rect: "CUT",
        circle: "CUT", slot: "CUT", gluetab: "CUT", handhole: "CUT",
        score: "SCORE", crease: "CREASE",
        dimension: "DIMENSION",
    };
    return map[tool] || "CUT";
};

// ─── Properties Panel ───────────────────────────────────────────────────────
DieLayoutEditor.prototype._updateProperties = function () {
    var active = this.canvas.getActiveObject();
    if (!active || active.cadType === "grid") {
        this._clearProperties();
        return;
    }
    var html = [
        '<div><b>Type:</b> ' + (active.cadType || active.type) + '</div>',
        '<div><b>Layer:</b> ' + (active.cadLayer || "—") + '</div>',
        '<div><b>Left:</b> ' + this._toUnits(active.left || 0).toFixed(3) + '"</div>',
        '<div><b>Top:</b> ' + this._toUnits(active.top || 0).toFixed(3) + '"</div>',
    ];
    if (active.width) html.push('<div><b>Width:</b> ' + this._toUnits(active.width * (active.scaleX || 1)).toFixed(3) + '"</div>');
    if (active.height) html.push('<div><b>Height:</b> ' + this._toUnits(active.height * (active.scaleY || 1)).toFixed(3) + '"</div>');
    if (active.radius) html.push('<div><b>Radius:</b> ' + this._toUnits(active.radius).toFixed(3) + '"</div>');
    this.$container.find(".dle-properties").html(html.join(""));
};

DieLayoutEditor.prototype._clearProperties = function () {
    this.$container.find(".dle-properties").html('<div class="text-muted" style="padding:8px 0;">Select an object to see properties</div>');
};

// ─── Save ───────────────────────────────────────────────────────────────────
DieLayoutEditor.prototype._save = function () {
    var self = this;
    if (!this.layoutName) return;

    var canvasJson = this._getCanvasJSON();
    frappe.call({
        method: "libracad.api.save_canvas",
        args: { layout_name: self.layoutName, canvas_json: canvasJson },
        callback: function (r) {
            if (r.message) {
                self.isDirty = false;
                frappe.show_alert({ message: "Saved (v" + r.message.canvas_version + ")", indicator: "green" });
            }
        },
    });
};

// ─── Zoom to Fit ────────────────────────────────────────────────────────────
DieLayoutEditor.prototype._zoomToFit = function () {
    var objects = this.canvas.getObjects().filter(function (o) { return o.cadType !== "grid"; });
    if (objects.length === 0) return;

    var group = new fabric.Group(objects);
    var bounds = group.getBoundingRect();
    group.destroy();

    var canvasW = this.canvas.getWidth();
    var canvasH = this.canvas.getHeight();
    var scaleX = canvasW / (bounds.width + 40);
    var scaleY = canvasH / (bounds.height + 40);
    var zoom = Math.min(scaleX, scaleY, 5);

    this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    this.canvas.setZoom(zoom);
    var vpw = canvasW / zoom;
    var vph = canvasH / zoom;
    var offsetX = (vpw - bounds.width) / 2 - bounds.left;
    var offsetY = (vph - bounds.height) / 2 - bounds.top;
    this.canvas.setViewportTransform([zoom, 0, 0, zoom, offsetX * zoom, offsetY * zoom]);
    this.canvas.renderAll();
};

// ─── Export SVG / PNG ───────────────────────────────────────────────────────
DieLayoutEditor.prototype._exportSVG = function () {
    var svg = this.canvas.toSVG({
        suppressPreamble: false,
        viewBox: { x: 0, y: 0, width: this.canvas.getWidth(), height: this.canvas.getHeight() },
    });
    // Filter out grid lines
    svg = svg.replace(/<[^>]*cadType="grid"[^>]*\/>/g, "");
    var blob = new Blob([svg], { type: "image/svg+xml" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = (this.layoutName || "die-layout") + ".svg";
    a.click();
    URL.revokeObjectURL(url);
};

DieLayoutEditor.prototype._exportPNG = function () {
    var dataUrl = this.canvas.toDataURL({ format: "png", multiplier: 2 });
    var a = document.createElement("a");
    a.href = dataUrl;
    a.download = (this.layoutName || "die-layout") + ".png";
    a.click();
};

// ─── Auto-Generate Parametric Layout ────────────────────────────────────────
DieLayoutEditor.prototype._autoGenerate = function () {
    var d = this.layoutData;
    if (!d || !d.box_style) {
        frappe.show_alert({ message: "No box style set on estimate. Cannot auto-generate.", indicator: "orange" });
        return;
    }

    // Clear existing non-grid objects
    var toRemove = this.canvas.getObjects().filter(function (o) { return o.cadType !== "grid"; });
    toRemove.forEach(function (o) { this.canvas.remove(o); }.bind(this));

    var L = d.length_inside || 0;
    var W = d.width_inside || 0;
    var D = d.depth_inside || 0;
    var caliper = d.caliper_in || 0.16; // default C-flute

    var style = (d.box_style || "").toUpperCase();

    // Route to correct generator
    if (style.indexOf("RSC") >= 0 || style === "0201" || style === "FEFCO 0201") {
        this._generateRSC(L, W, D, caliper);
    } else if (style.indexOf("FOL") >= 0 || style === "0203") {
        this._generateFOL(L, W, D, caliper);
    } else if (style.indexOf("HSC") >= 0 || style === "0202") {
        this._generateHSC(L, W, D, caliper);
    } else if (style.indexOf("BLISS") >= 0) {
        this._generateBLISS(L, W, D, caliper);
    } else if (style.indexOf("TRAY") >= 0 || style.indexOf("SFF") >= 0) {
        this._generateTRAY(L, W, D, caliper);
    } else if (style.indexOf("PIZZA") >= 0) {
        this._generateTRAY(L, W, D, caliper); // Pizza uses tray geometry
    } else {
        // Default to RSC for any unknown style (DIE-CUT, etc.)
        this._generateRSC(L, W, D, caliper);
    }

    this._zoomToFit();
    this._saveUndoState();
    this.isDirty = true;
    frappe.show_alert({ message: "Layout generated for " + d.box_style, indicator: "green" });
};

// ─── RSC Generator (mirrors cad_generator.py lines 101-179) ────────────────
DieLayoutEditor.prototype._generateRSC = function (L, W, D, caliper) {
    var px = this._toPixels.bind(this);
    var cal2 = 2 * caliper;

    // Panel x-boundaries
    var x0 = 0;
    var x1 = px(JOINT);
    var x2 = px(JOINT + W);
    var x3 = px(JOINT + W + L);
    var x4 = px(JOINT + 2 * W + L);
    var x5 = px(JOINT + 2 * W + 2 * L);

    // Flap y-boundaries
    var flap_h = D / 2 + cal2;
    var y0 = 0;
    var y1 = px(flap_h);
    var y2 = px(flap_h + D);
    var y3 = px(2 * flap_h + D);

    var self = this;

    function addLine(x1v, y1v, x2v, y2v, layer) {
        var def = LAYERS[layer];
        var line = new fabric.Line([x1v, y1v, x2v, y2v], {
            stroke: def.color,
            strokeWidth: def.width,
            strokeDashArray: def.dash,
            selectable: true,
            cadLayer: layer,
            cadType: "generated",
        });
        self.canvas.add(line);
    }

    function addText(text, x, y) {
        var t = new fabric.IText(text, {
            left: x, top: y,
            fontSize: 10,
            fill: LAYERS.ANNOTATION.color,
            fontFamily: "monospace",
            cadLayer: "ANNOTATION",
            cadType: "label",
        });
        self.canvas.add(t);
    }

    // ── CUT: Outer boundary ──
    // Top edge
    addLine(x1, y0, x2, y0, "CUT");
    addLine(x2, y0, x3, y0, "CUT");
    addLine(x3, y0, x4, y0, "CUT");
    // Bottom edge
    addLine(x1, y3, x2, y3, "CUT");
    addLine(x2, y3, x3, y3, "CUT");
    addLine(x3, y3, x4, y3, "CUT");
    // Left edge (glue tab)
    addLine(x0, y1, x0, y2, "CUT");
    addLine(x0, y1, x1, y0, "CUT");  // Tapered top
    addLine(x0, y2, x1, y3, "CUT");  // Tapered bottom
    // Right edge
    addLine(x5, y0, x5, y3, "CUT");
    // Left vertical at x1
    addLine(x1, y0, x1, y1, "CUT");
    addLine(x1, y2, x1, y3, "CUT");
    // Right vertical at x4
    addLine(x4, y0, x4, y1, "CUT");
    addLine(x4, y2, x4, y3, "CUT");

    // ── CUT: Slot cuts between flaps ──
    addLine(x2, y0, x2, y1, "CUT");
    addLine(x3, y0, x3, y1, "CUT");
    addLine(x2, y2, x2, y3, "CUT");
    addLine(x3, y2, x3, y3, "CUT");

    // ── SCORE: Vertical panel separators (body zone) ──
    addLine(x1, y1, x1, y2, "SCORE");
    addLine(x2, y1, x2, y2, "SCORE");
    addLine(x3, y1, x3, y2, "SCORE");
    addLine(x4, y1, x4, y2, "SCORE");

    // ── SCORE: Horizontal flap junctions ──
    addLine(x0, y1, x5, y1, "SCORE");
    addLine(x0, y2, x5, y2, "SCORE");

    // ── DIMENSION: Panel widths ──
    var dimY = y3 + px(0.5);
    addText('W=' + W + '"', x1, dimY);
    addText('L=' + L + '"', x2, dimY);
    addText('W=' + W + '"', x3, dimY);
    addText('L=' + L + '"', x4, dimY);

    // ── DIMENSION: Flap heights ──
    var dimX = x5 + px(0.3);
    addText('Flap=' + (D / 2).toFixed(2) + '"', dimX, y0);
    addText('D=' + D + '"', dimX, y1);
    addText('Flap=' + (D / 2).toFixed(2) + '"', dimX, y2);

    // ── ANNOTATION: Panel labels ──
    addText("GLUE TAB", x0 + 2, y1 + px(D / 2) - 6);
    addText("WIDTH", x1 + px(W / 2) - 15, y1 + px(D / 2) - 6);
    addText("LENGTH", x2 + px(L / 2) - 15, y1 + px(D / 2) - 6);
    addText("WIDTH", x3 + px(W / 2) - 15, y1 + px(D / 2) - 6);
    addText("LENGTH", x4 + px(L / 2) - 15, y1 + px(D / 2) - 6);
};

// ─── FOL Generator (mirrors cad_generator.py lines 182-237) ────────────────
DieLayoutEditor.prototype._generateFOL = function (L, W, D, caliper) {
    var px = this._toPixels.bind(this);
    var cal2 = 2 * caliper;

    var x0 = 0;
    var x1 = px(JOINT);
    var x2 = px(JOINT + W);
    var x3 = px(JOINT + W + L);
    var x4 = px(JOINT + 2 * W + L);

    var flap_h = D / 2 + cal2;
    var y0 = 0;
    var y1 = px(flap_h);
    var y2 = px(flap_h + D);
    var y3 = px(2 * flap_h + D);

    var self = this;
    function addLine(x1v, y1v, x2v, y2v, layer) {
        var def = LAYERS[layer];
        self.canvas.add(new fabric.Line([x1v, y1v, x2v, y2v], {
            stroke: def.color, strokeWidth: def.width, strokeDashArray: def.dash,
            selectable: true, cadLayer: layer, cadType: "generated",
        }));
    }

    // CUT: outer boundary
    addLine(x0, y0, x4, y0, "CUT");
    addLine(x0, y3, x4, y3, "CUT");
    addLine(x0, y0, x0, y3, "CUT");
    addLine(x4, y0, x4, y3, "CUT");

    // CUT: slot cuts
    addLine(x1, y0, x1, y1, "CUT");
    addLine(x2, y0, x2, y1, "CUT");
    addLine(x3, y0, x3, y1, "CUT");
    addLine(x1, y2, x1, y3, "CUT");
    addLine(x2, y2, x2, y3, "CUT");
    addLine(x3, y2, x3, y3, "CUT");

    // SCORE: panel dividers (body)
    addLine(x1, y1, x1, y2, "SCORE");
    addLine(x2, y1, x2, y2, "SCORE");
    addLine(x3, y1, x3, y2, "SCORE");

    // SCORE: flap junctions
    addLine(x0, y1, x4, y1, "SCORE");
    addLine(x0, y2, x4, y2, "SCORE");
};

// ─── HSC Generator (mirrors cad_generator.py lines 240-286) ────────────────
DieLayoutEditor.prototype._generateHSC = function (L, W, D, caliper) {
    var px = this._toPixels.bind(this);
    var cal2 = 2 * caliper;

    var x0 = 0;
    var x1 = px(JOINT);
    var x2 = px(JOINT + L);
    var x3 = px(JOINT + L + W);
    var x4 = px(JOINT + 2 * L + W);
    var x5 = px(JOINT + 2 * L + 2 * W);

    var flap_h = Math.min(L, W) / 2 + cal2;
    var y0 = 0;
    var y1 = px(flap_h);
    var y2 = px(flap_h + D);
    var y3 = px(2 * flap_h + D);

    var self = this;
    function addLine(x1v, y1v, x2v, y2v, layer) {
        var def = LAYERS[layer];
        self.canvas.add(new fabric.Line([x1v, y1v, x2v, y2v], {
            stroke: def.color, strokeWidth: def.width, strokeDashArray: def.dash,
            selectable: true, cadLayer: layer, cadType: "generated",
        }));
    }

    // CUT: outer boundary
    addLine(x0, y1, x0, y2, "CUT");
    addLine(x0, y1, x1, y0, "CUT");
    addLine(x0, y2, x1, y3, "CUT");
    addLine(x1, y0, x4, y0, "CUT");
    addLine(x1, y3, x4, y3, "CUT");
    addLine(x5, y0, x5, y3, "CUT");
    addLine(x4, y0, x4, y1, "CUT");
    addLine(x4, y2, x4, y3, "CUT");

    // CUT: slot cuts
    addLine(x1, y0, x1, y1, "CUT");
    addLine(x2, y0, x2, y1, "CUT");
    addLine(x3, y0, x3, y1, "CUT");
    addLine(x1, y2, x1, y3, "CUT");
    addLine(x2, y2, x2, y3, "CUT");
    addLine(x3, y2, x3, y3, "CUT");

    // SCORE: panel dividers
    addLine(x1, y1, x1, y2, "SCORE");
    addLine(x2, y1, x2, y2, "SCORE");
    addLine(x3, y1, x3, y2, "SCORE");
    addLine(x4, y1, x4, y2, "SCORE");

    // SCORE: flap junctions
    addLine(x0, y1, x5, y1, "SCORE");
    addLine(x0, y2, x5, y2, "SCORE");
};

// ─── BLISS Generator (wrap-around box) ──────────────────────────────────────
DieLayoutEditor.prototype._generateBLISS = function (L, W, D, caliper) {
    var px = this._toPixels.bind(this);
    var cal2 = 2 * caliper;

    // BLISS is a wrap-around: Bottom → Front → Top → Back, with side tuck flaps
    var x0 = 0;
    var x1 = px(D);            // left flap fold
    var x2 = px(D + L);        // right flap fold
    var x3 = px(2 * D + L);    // right edge

    var y0 = 0;
    var y1 = px(W);            // back fold
    var y2 = px(W + D);        // top fold
    var y3 = px(2 * W + D);    // front fold
    var y4 = px(2 * W + 2 * D); // bottom edge (with overlap)

    var self = this;
    function addLine(x1v, y1v, x2v, y2v, layer) {
        var def = LAYERS[layer];
        self.canvas.add(new fabric.Line([x1v, y1v, x2v, y2v], {
            stroke: def.color, strokeWidth: def.width, strokeDashArray: def.dash,
            selectable: true, cadLayer: layer, cadType: "generated",
        }));
    }

    // CUT: outer boundary
    addLine(x0, y0, x3, y0, "CUT");  // top
    addLine(x0, y4, x3, y4, "CUT");  // bottom
    addLine(x0, y0, x0, y4, "CUT");  // left
    addLine(x3, y0, x3, y4, "CUT");  // right

    // SCORE: panel folds (horizontal)
    addLine(x0, y1, x3, y1, "SCORE");  // back/top fold
    addLine(x0, y2, x3, y2, "SCORE");  // top/front fold
    addLine(x0, y3, x3, y3, "SCORE");  // front/bottom fold

    // SCORE: side flap folds (vertical)
    addLine(x1, y0, x1, y4, "SCORE");  // left panel fold
    addLine(x2, y0, x2, y4, "SCORE");  // right panel fold

    // CUT: side flap slot cuts (at each horizontal fold)
    addLine(x0, y1, x1, y1, "CUT");
    addLine(x2, y1, x3, y1, "CUT");
    addLine(x0, y2, x1, y2, "CUT");
    addLine(x2, y2, x3, y2, "CUT");
    addLine(x0, y3, x1, y3, "CUT");
    addLine(x2, y3, x3, y3, "CUT");

    // DIMENSION lines
    addLine(x1, y1 - px(0.3), x2, y1 - px(0.3), "DIMENSION");  // L across top
    addLine(x0 - px(0.3), y1, x0 - px(0.3), y2, "DIMENSION");  // D on left

    // Labels
    var cx = (x1 + x2) / 2, fh = 10;
    [{x: cx, y: (y0 + y1) / 2, t: "BACK"},
     {x: cx, y: (y1 + y2) / 2, t: "TOP"},
     {x: cx, y: (y2 + y3) / 2, t: "FRONT"},
     {x: cx, y: (y3 + y4) / 2, t: "BOTTOM"}].forEach(function(p) {
        self.canvas.add(new fabric.IText(p.t, {
            left: p.x - 15, top: p.y - 5, fontSize: fh,
            fill: LAYERS.ANNOTATION.color, fontFamily: "monospace",
            cadLayer: "ANNOTATION", cadType: "label",
        }));
    });
};

// ─── TRAY / SFF Generator (open-top tray with folding walls) ────────────────
DieLayoutEditor.prototype._generateTRAY = function (L, W, D, caliper) {
    var px = this._toPixels.bind(this);

    // Tray blank: side flaps fold up to form walls
    // Center panel = L x W, surrounded by D-height flaps
    var x0 = 0;
    var x1 = px(D);            // left wall fold
    var x2 = px(D + L);        // right wall fold
    var x3 = px(2 * D + L);    // right edge

    var y0 = 0;
    var y1 = px(D);            // front wall fold
    var y2 = px(D + W);        // back wall fold
    var y3 = px(2 * D + W);    // bottom edge

    var self = this;
    function addLine(x1v, y1v, x2v, y2v, layer) {
        var def = LAYERS[layer];
        self.canvas.add(new fabric.Line([x1v, y1v, x2v, y2v], {
            stroke: def.color, strokeWidth: def.width, strokeDashArray: def.dash,
            selectable: true, cadLayer: layer, cadType: "generated",
        }));
    }

    // CUT: outer boundary
    addLine(x0, y0, x3, y0, "CUT");
    addLine(x0, y3, x3, y3, "CUT");
    addLine(x0, y0, x0, y3, "CUT");
    addLine(x3, y0, x3, y3, "CUT");

    // SCORE: wall folds
    addLine(x1, y0, x1, y3, "SCORE");  // left wall
    addLine(x2, y0, x2, y3, "SCORE");  // right wall
    addLine(x0, y1, x3, y1, "SCORE");  // front wall
    addLine(x0, y2, x3, y2, "SCORE");  // back wall

    // CUT: corner relief cuts (allow walls to fold up)
    addLine(x0, y1, x1, y1, "CUT");  // front-left
    addLine(x0, y2, x1, y2, "CUT");  // back-left
    addLine(x2, y1, x3, y1, "CUT");  // front-right
    addLine(x2, y2, x3, y2, "CUT");  // back-right

    // Labels
    self.canvas.add(new fabric.IText("BOTTOM", {
        left: (x1 + x2) / 2 - 20, top: (y1 + y2) / 2 - 5, fontSize: 10,
        fill: LAYERS.ANNOTATION.color, fontFamily: "monospace",
        cadLayer: "ANNOTATION", cadType: "label",
    }));
    [{x: (x1 + x2) / 2, y: (y0 + y1) / 2, t: "FRONT"},
     {x: (x1 + x2) / 2, y: (y2 + y3) / 2, t: "BACK"},
     {x: (x0 + x1) / 2, y: (y1 + y2) / 2, t: "LEFT"},
     {x: (x2 + x3) / 2, y: (y1 + y2) / 2, t: "RIGHT"}].forEach(function(p) {
        self.canvas.add(new fabric.IText(p.t, {
            left: p.x - 12, top: p.y - 5, fontSize: 9,
            fill: LAYERS.ANNOTATION.color, fontFamily: "monospace",
            cadLayer: "ANNOTATION", cadType: "label",
        }));
    });
};

// ═══════════════════════════════════════════════════════════════════════════
//  TAB SYSTEM — Editor | Nesting | 3D Preview | Palletize
// ═══════════════════════════════════════════════════════════════════════════

DieLayoutEditor.prototype._bindTabs = function () {
    var self = this;
    this.$container.find(".dle-tab").on("click", function () {
        var tab = $(this).data("tab");
        self.$container.find(".dle-tab").removeClass("active").css({ "border-bottom": "none", "color": "#8d99a6", "font-weight": "normal" });
        $(this).addClass("active").css({ "border-bottom": "2px solid #171717", "color": "#171717", "font-weight": "600" });
        self.$container.find(".dle-tab-content").hide();
        self.$container.find('.dle-tab-content[data-tab="' + tab + '"]').show();

        if (tab === "nesting") self._loadNesting();
        if (tab === "preview3d") self._render3DPreview();
        if (tab === "palletize") self._loadPalletize();
    });

    // Pallet calculate button
    this.$container.find(".dle-pallet-calc").on("click", function () { self._loadPalletize(); });
};

// ═══════════════════════════════════════════════════════════════════════════
//  NESTING VISUALIZATION
// ═══════════════════════════════════════════════════════════════════════════

DieLayoutEditor.prototype._loadNesting = function () {
    var self = this;
    if (!this.layoutData || !this.layoutData.corrugated_estimate) return;

    frappe.call({
        method: "libracad.api.get_nesting_layout",
        args: { estimate_name: this.layoutData.corrugated_estimate },
        callback: function (r) {
            if (r.message) {
                self._renderNestingSVG(r.message.layout);
                self._renderNestingMetrics(r.message.layout);
                self._renderMachineTable(r.message.all_machines, r.message.layout);
            }
        },
    });
};

DieLayoutEditor.prototype._renderNestingSVG = function (layout) {
    if (!layout || layout.total_outs === 0) {
        this.$container.find(".dle-nesting-svg").html('<div class="text-muted" style="padding:40px;">No valid nesting layout. Blank may be too large for available machines.</div>');
        return;
    }

    var sL = layout.sheet_length;
    var sW = layout.sheet_width;
    var scale = Math.min(700 / sL, 450 / sW, 8);
    var svgW = sL * scale + 40;
    var svgH = sW * scale + 40;
    var ox = 20, oy = 20; // offset

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '" style="max-width:100%;">';

    // Defs for hatching
    svg += '<defs>';
    svg += '<pattern id="trim-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">';
    svg += '<line x1="0" y1="0" x2="0" y2="6" stroke="#FF6B6B" stroke-width="1" opacity="0.4"/>';
    svg += '</pattern>';
    svg += '<pattern id="waste-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">';
    svg += '<line x1="0" y1="0" x2="0" y2="8" stroke="#FF9800" stroke-width="1" opacity="0.2"/>';
    svg += '</pattern>';
    svg += '</defs>';

    // Sheet background (waste area)
    svg += '<rect x="' + ox + '" y="' + oy + '" width="' + (sL * scale) + '" height="' + (sW * scale) + '" fill="url(#waste-hatch)" stroke="#999" stroke-width="2"/>';

    // Trim zones
    var trim = layout.trim_allowance * scale;
    var grip = layout.gripper_edge * scale;
    // Left trim
    svg += '<rect x="' + ox + '" y="' + oy + '" width="' + (trim + grip) + '" height="' + (sW * scale) + '" fill="url(#trim-hatch)"/>';
    // Right trim
    svg += '<rect x="' + (ox + sL * scale - trim) + '" y="' + oy + '" width="' + trim + '" height="' + (sW * scale) + '" fill="url(#trim-hatch)"/>';
    // Top trim
    svg += '<rect x="' + ox + '" y="' + oy + '" width="' + (sL * scale) + '" height="' + trim + '" fill="url(#trim-hatch)"/>';
    // Bottom trim
    svg += '<rect x="' + ox + '" y="' + (oy + sW * scale - trim) + '" width="' + (sL * scale) + '" height="' + trim + '" fill="url(#trim-hatch)"/>';

    // Gripper edge label
    svg += '<text x="' + (ox + (trim + grip) / 2) + '" y="' + (oy + sW * scale / 2) + '" text-anchor="middle" font-size="9" fill="#c00" transform="rotate(-90,' + (ox + (trim + grip) / 2) + ',' + (oy + sW * scale / 2) + ')">GRIPPER</text>';

    // Blank positions
    var colors = ["#4FC3F7", "#81C784", "#FFB74D", "#BA68C8", "#E57373", "#4DB6AC"];
    var positions = layout.layout_positions || [];
    for (var i = 0; i < positions.length; i++) {
        var p = positions[i];
        var bx = ox + p.x * scale;
        var by = oy + p.y * scale;
        var bw = p.width * scale;
        var bh = p.height * scale;
        var color = colors[i % colors.length];

        // Blank rectangle
        svg += '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh + '" fill="' + color + '" fill-opacity="0.3" stroke="' + color + '" stroke-width="1.5" rx="2"/>';

        // Simplified die-cut outline inside blank (just show score lines)
        var innerMargin = Math.min(bw, bh) * 0.08;
        svg += '<rect x="' + (bx + innerMargin) + '" y="' + (by + innerMargin) + '" width="' + (bw - 2 * innerMargin) + '" height="' + (bh - 2 * innerMargin) + '" fill="none" stroke="' + color + '" stroke-width="0.5" stroke-dasharray="3,2"/>';

        // Out number
        svg += '<text x="' + (bx + bw / 2) + '" y="' + (by + bh / 2 + 5) + '" text-anchor="middle" font-size="' + Math.min(14, bw * 0.3) + '" font-weight="700" fill="' + color + '">#' + (i + 1) + '</text>';

        // Dimensions on first blank only
        if (i === 0) {
            svg += '<text x="' + (bx + bw / 2) + '" y="' + (by - 4) + '" text-anchor="middle" font-size="9" fill="#333">' + p.width.toFixed(1) + '"</text>';
            svg += '<text x="' + (bx + bw + 4) + '" y="' + (by + bh / 2) + '" font-size="9" fill="#333" transform="rotate(90,' + (bx + bw + 4) + ',' + (by + bh / 2) + ')">' + p.height.toFixed(1) + '"</text>';
        }
    }

    // Sheet dimension callouts
    svg += '<text x="' + (ox + sL * scale / 2) + '" y="' + (oy + sW * scale + 16) + '" text-anchor="middle" font-size="12" font-weight="600" fill="#c00">' + sL.toFixed(1) + '"</text>';
    svg += '<text x="' + (ox - 8) + '" y="' + (oy + sW * scale / 2) + '" text-anchor="middle" font-size="12" font-weight="600" fill="#c00" transform="rotate(-90,' + (ox - 8) + ',' + (oy + sW * scale / 2) + ')">' + sW.toFixed(1) + '"</text>';

    // Gutter annotation
    if (positions.length > 1) {
        svg += '<text x="' + (ox + sL * scale / 2) + '" y="' + (oy - 6) + '" text-anchor="middle" font-size="9" fill="#666">Gutter: ' + layout.gutter + '"</text>';
    }

    svg += '</svg>';
    this.$container.find(".dle-nesting-svg").html(svg);
};

DieLayoutEditor.prototype._renderNestingMetrics = function (layout) {
    var utilColor = layout.utilization_pct > 70 ? "#4CAF50" : layout.utilization_pct > 50 ? "#FF9800" : "#F44336";
    var html = [
        '<div style="display:grid; gap:10px;">',
        '  <div style="text-align:center; padding:12px; background:#e8f5e9; border-radius:6px;">',
        '    <div style="font-size:28px; font-weight:800; color:#2E7D32;">' + layout.total_outs + '</div>',
        '    <div style="font-size:11px; color:#666;">OUTS PER SHEET</div>',
        '  </div>',
        '  <div style="display:flex; gap:8px;">',
        '    <div style="flex:1; text-align:center; padding:8px; background:#fff3e0; border-radius:6px;">',
        '      <div style="font-size:18px; font-weight:700; color:#E65100;">' + layout.waste_pct + '%</div>',
        '      <div style="font-size:10px; color:#666;">WASTE</div>',
        '    </div>',
        '    <div style="flex:1; text-align:center; padding:8px; background:#e3f2fd; border-radius:6px;">',
        '      <div style="font-size:18px; font-weight:700; color:' + utilColor + ';">' + layout.utilization_pct + '%</div>',
        '      <div style="font-size:10px; color:#666;">UTILIZATION</div>',
        '    </div>',
        '  </div>',
        '  <div style="font-size:12px; line-height:1.8;">',
        '    <div><b>Layout:</b> ' + layout.outs_across + ' across x ' + layout.outs_down + ' down</div>',
        '    <div><b>Sheet:</b> ' + layout.sheet_length.toFixed(1) + '" x ' + layout.sheet_width.toFixed(1) + '"</div>',
        '    <div><b>Usable:</b> ' + layout.usable_length.toFixed(1) + '" x ' + layout.usable_width.toFixed(1) + '"</div>',
        '    <div><b>Blank:</b> ' + layout.blank_length.toFixed(1) + '" x ' + layout.blank_width.toFixed(1) + '"</div>',
        '    <div><b>Orientation:</b> ' + (layout.blank_orientation || "0deg") + '</div>',
        '    <div><b>Gutter:</b> ' + layout.gutter + '"</div>',
        '    <div><b>Machine:</b> ' + (layout.machine_name || "Default") + '</div>',
        '    <div style="margin-top:6px; padding-top:6px; border-top:1px solid #eee;">',
        '      <b>Blank Area:</b> ' + layout.total_blank_area_sqft.toFixed(2) + ' sq ft</div>',
        '    <div><b>Sheet Area:</b> ' + layout.sheet_area_sqft.toFixed(2) + ' sq ft</div>',
        '  </div>',
        '</div>',
    ].join("\n");
    this.$container.find(".dle-nesting-stats").html(html);
};

DieLayoutEditor.prototype._renderMachineTable = function (machines, currentLayout) {
    if (!machines || machines.length === 0) {
        this.$container.find(".dle-machine-list").html('<div class="text-muted">No die-cut machines configured</div>');
        return;
    }

    var html = '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
    html += '<tr style="border-bottom:1px solid #ddd;"><th style="padding:4px; text-align:left;">Machine</th><th>Outs</th><th>Waste</th><th>Sheet</th></tr>';

    for (var i = 0; i < machines.length; i++) {
        var m = machines[i];
        var isBest = i === 0;
        var bg = isBest ? "#e8f5e9" : (i % 2 === 0 ? "#fff" : "#fafafa");
        html += '<tr style="background:' + bg + '; cursor:pointer;" data-machine="' + m.machine_id + '">';
        html += '<td style="padding:4px;">' + (isBest ? "<b>" : "") + m.machine_name + (isBest ? " *</b>" : "") + '</td>';
        html += '<td style="padding:4px; text-align:center; font-weight:700;">' + m.total_outs + '</td>';
        html += '<td style="padding:4px; text-align:center;">' + m.waste_pct + '%</td>';
        html += '<td style="padding:4px; text-align:center; font-size:10px;">' + m.sheet_length.toFixed(0) + 'x' + m.sheet_width.toFixed(0) + '</td>';
        html += '</tr>';
    }
    html += '</table>';

    this.$container.find(".dle-machine-list").html(html);

    // Click machine row to re-render nesting
    var self = this;
    this.$container.find(".dle-machine-list tr[data-machine]").on("click", function () {
        var mid = $(this).data("machine");
        frappe.call({
            method: "libracad.api.get_nesting_layout",
            args: { estimate_name: self.layoutData.corrugated_estimate, machine_id: mid },
            callback: function (r) {
                if (r.message) {
                    self._renderNestingSVG(r.message.layout);
                    self._renderNestingMetrics(r.message.layout);
                }
            },
        });
    });
};

// ═══════════════════════════════════════════════════════════════════════════
//  3D BOX PREVIEW — CSS 3D Transforms
// ═══════════════════════════════════════════════════════════════════════════

DieLayoutEditor.prototype._render3DPreview = function () {
    var d = this.layoutData;
    if (!d) return;

    var L = d.length_inside || 12;
    var W = d.width_inside || 10;
    var D = d.depth_inside || 8;
    var style = (d.box_style || "RSC").toUpperCase();
    var caliper = d.caliper_in || 0.15;

    // Scale to fit viewport (max 200px per dimension)
    var maxDim = Math.max(L, W, D);
    var sc = Math.min(180 / maxDim, 30);
    var sL = L * sc, sW = W * sc, sD = D * sc;

    var isOpenTop = (style === "HSC" || style === "TRAY");

    var faces = {
        front:  { w: sL, h: sD, tx: 0,       ty: 0,       tz: sW / 2,  rx: 0,   ry: 0,   color: "#4FC3F7", label: "FRONT " + L + '"x' + D + '"' },
        back:   { w: sL, h: sD, tx: 0,       ty: 0,       tz: -sW / 2, rx: 0,   ry: 180, color: "#4FC3F7", label: "BACK" },
        left:   { w: sW, h: sD, tx: -sL / 2, ty: 0,       tz: 0,       rx: 0,   ry: -90, color: "#81C784", label: "LEFT " + W + '"x' + D + '"' },
        right:  { w: sW, h: sD, tx: sL / 2,  ty: 0,       tz: 0,       rx: 0,   ry: 90,  color: "#81C784", label: "RIGHT" },
        bottom: { w: sL, h: sW, tx: 0,       ty: sD / 2,  tz: 0,       rx: 90,  ry: 0,   color: "#FFB74D", label: "BOTTOM " + L + '"x' + W + '"' },
    };

    if (!isOpenTop) {
        faces.top = { w: sL, h: sW, tx: 0, ty: -sD / 2, tz: 0, rx: -90, ry: 0, color: "#CE93D8", label: "TOP" };
    }

    var boxHtml = '';
    for (var name in faces) {
        var f = faces[name];
        boxHtml += '<div style="position:absolute; width:' + f.w + 'px; height:' + f.h + 'px; ' +
            'background:' + f.color + '; opacity:0.85; border:2px solid rgba(0,0,0,0.3); ' +
            'display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:600; color:rgba(0,0,0,0.6); ' +
            'transform: translate3d(' + f.tx + 'px,' + f.ty + 'px,' + f.tz + 'px) rotateX(' + f.rx + 'deg) rotateY(' + f.ry + 'deg); ' +
            'backface-visibility:hidden;">' + f.label + '</div>';
    }

    // Flap indicators for RSC/FOL
    if (style === "RSC" || style === "FOL" || style === "SFF") {
        var flapH = Math.min(sD * 0.15, 15);
        // Top flaps (slightly open)
        if (!isOpenTop) {
            boxHtml += '<div style="position:absolute; width:' + sL + 'px; height:' + flapH + 'px; ' +
                'background:#CE93D8; opacity:0.5; border:1px solid rgba(0,0,0,0.2); ' +
                'transform: translate3d(0,' + (-sD / 2 - flapH / 2) + 'px,' + (sW / 2 + flapH / 2) + 'px) rotateX(-60deg); ' +
                'transform-origin: center bottom;"></div>';
        }
    }

    var scene = this.$container.find(".dle-3d-scene");
    var box = this.$container.find(".dle-3d-box");
    box.html(boxHtml);
    box.css({
        "transform": "rotateX(-25deg) rotateY(-35deg)",
        "transform-style": "preserve-3d",
    });

    // Make draggable to rotate
    var isDragging = false, startX, startY, rotX = -25, rotY = -35;
    scene.off("mousedown mousemove mouseup mouseleave");
    scene.on("mousedown", function (e) { isDragging = true; startX = e.clientX; startY = e.clientY; });
    scene.on("mousemove", function (e) {
        if (!isDragging) return;
        rotY += (e.clientX - startX) * 0.5;
        rotX += (e.clientY - startY) * -0.5;
        box.css("transform", "rotateX(" + rotX + "deg) rotateY(" + rotY + "deg)");
        startX = e.clientX; startY = e.clientY;
    });
    scene.on("mouseup mouseleave", function () { isDragging = false; });

    // Info panel
    var infoHtml = [
        '<div style="line-height:2;">',
        '<div><b>Style:</b> ' + (d.box_style || "RSC") + '</div>',
        '<div><b>Inside:</b> ' + L + '" x ' + W + '" x ' + D + '"</div>',
        '<div><b>Outside:</b> ' + (L + 2 * caliper).toFixed(2) + '" x ' + (W + 2 * caliper).toFixed(2) + '" x ' + (D + 2 * caliper).toFixed(2) + '"</div>',
        '<div><b>Flute:</b> ' + (d.flute_type || "C") + ' (' + caliper + '" caliper)</div>',
        '<div style="margin-top:10px; font-size:11px; color:#aaa;">' + (isOpenTop ? "Open top design" : "Fully enclosed") + '</div>',
        '<div style="margin-top:10px; font-size:11px; color:#aaa;">Drag to rotate</div>',
        '</div>',
    ].join("");
    this.$container.find(".dle-3d-info").html(infoHtml);
};

// ═══════════════════════════════════════════════════════════════════════════
//  PALLETIZING VISUALIZATION
// ═══════════════════════════════════════════════════════════════════════════

DieLayoutEditor.prototype._loadPalletize = function () {
    var d = this.layoutData;
    if (!d) return;

    var caliper = d.caliper_in || 0.15;
    var boxL = (d.length_inside || 12) + 2 * caliper;
    var boxW = (d.width_inside || 10) + 2 * caliper;
    var boxH = (d.depth_inside || 8) + 2 * caliper;

    // Pallet dimensions
    var palletStr = this.$container.find(".dle-pallet-size").val() || "48x40";
    var palletParts = palletStr.split("x");
    var palletL = parseInt(palletParts[0]);
    var palletW = parseInt(palletParts[1]);
    var maxHeight = parseFloat(this.$container.find(".dle-pallet-max-height").val()) || 48;
    var pattern = this.$container.find(".dle-pallet-pattern").val() || "column";

    // Calculate best orientation
    var orient1 = { across: Math.floor(palletL / boxL), down: Math.floor(palletW / boxW), bL: boxL, bW: boxW };
    var orient2 = { across: Math.floor(palletL / boxW), down: Math.floor(palletW / boxL), bL: boxW, bW: boxL };
    orient1.total = orient1.across * orient1.down;
    orient2.total = orient2.across * orient2.down;

    var best = orient1.total >= orient2.total ? orient1 : orient2;
    var layers = Math.floor(maxHeight / boxH);
    var totalBoxes = best.total * layers;
    var palletHeight = layers * boxH + 6; // 6" pallet deck height

    // Render top-down SVG
    this._renderPalletTopDown(best, palletL, palletW, pattern);

    // Render 3D isometric
    this._renderPallet3D(best, boxH, layers, palletL, palletW);

    // Metrics
    var metricsHtml = [
        '<div style="display:grid; gap:10px;">',
        '  <div style="text-align:center; padding:12px; background:#e8f5e9; border-radius:6px;">',
        '    <div style="font-size:28px; font-weight:800; color:#2E7D32;">' + totalBoxes + '</div>',
        '    <div style="font-size:11px; color:#666;">BOXES PER PALLET</div>',
        '  </div>',
        '  <div style="display:flex; gap:8px;">',
        '    <div style="flex:1; text-align:center; padding:8px; background:#e3f2fd; border-radius:6px;">',
        '      <div style="font-size:18px; font-weight:700; color:#1565C0;">' + best.total + '</div>',
        '      <div style="font-size:10px; color:#666;">PER LAYER</div>',
        '    </div>',
        '    <div style="flex:1; text-align:center; padding:8px; background:#fff3e0; border-radius:6px;">',
        '      <div style="font-size:18px; font-weight:700; color:#E65100;">' + layers + '</div>',
        '      <div style="font-size:10px; color:#666;">LAYERS</div>',
        '    </div>',
        '  </div>',
        '  <div style="font-size:12px; line-height:1.8;">',
        '    <div><b>Pallet:</b> ' + palletL + '" x ' + palletW + '"</div>',
        '    <div><b>Box (outside):</b> ' + boxL.toFixed(2) + '" x ' + boxW.toFixed(2) + '" x ' + boxH.toFixed(2) + '"</div>',
        '    <div><b>Layout:</b> ' + best.across + ' x ' + best.down + '</div>',
        '    <div><b>Pallet Height:</b> ' + palletHeight.toFixed(1) + '"</div>',
        '    <div><b>Max Height:</b> ' + maxHeight + '"</div>',
        '    <div><b>Pattern:</b> ' + (pattern === "interlock" ? "Interlocking" : "Column") + '</div>',
        '    <div style="margin-top:8px; padding-top:8px; border-top:1px solid #eee;">',
        '      <b>Floor utilization:</b> ' + ((best.total * best.bL * best.bW) / (palletL * palletW) * 100).toFixed(1) + '%</div>',
        '  </div>',
        '</div>',
    ].join("\n");
    this.$container.find(".dle-pallet-metrics").html(metricsHtml);
};

DieLayoutEditor.prototype._renderPalletTopDown = function (best, palletL, palletW, pattern) {
    var scale = Math.min(450 / palletL, 320 / palletW, 6);
    var svgW = palletL * scale + 40;
    var svgH = palletW * scale + 40;
    var ox = 20, oy = 20;

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '" style="max-width:100%;">';

    // Pallet deck
    svg += '<rect x="' + ox + '" y="' + oy + '" width="' + (palletL * scale) + '" height="' + (palletW * scale) + '" fill="#D7CCC8" stroke="#8D6E63" stroke-width="2" rx="3"/>';
    // Pallet slats
    for (var s = 0; s < 3; s++) {
        var slY = oy + (palletW * scale) * (s + 1) / 4;
        svg += '<line x1="' + ox + '" y1="' + slY + '" x2="' + (ox + palletL * scale) + '" y2="' + slY + '" stroke="#BCAAA4" stroke-width="1"/>';
    }

    // Box footprints
    var colors = ["#4FC3F7", "#81C784", "#FFB74D", "#BA68C8"];
    var count = 0;
    for (var r = 0; r < best.down; r++) {
        for (var c = 0; c < best.across; c++) {
            var bx = ox + c * best.bL * scale;
            var by = oy + r * best.bW * scale;
            var bw = best.bL * scale;
            var bh = best.bW * scale;
            var color = colors[count % colors.length];
            count++;

            svg += '<rect x="' + (bx + 1) + '" y="' + (by + 1) + '" width="' + (bw - 2) + '" height="' + (bh - 2) + '" fill="' + color + '" fill-opacity="0.4" stroke="' + color + '" stroke-width="1.5" rx="2"/>';
            // Cross pattern inside box
            svg += '<line x1="' + (bx + 1) + '" y1="' + (by + 1) + '" x2="' + (bx + bw - 1) + '" y2="' + (by + bh - 1) + '" stroke="' + color + '" stroke-width="0.5" opacity="0.3"/>';
            svg += '<line x1="' + (bx + bw - 1) + '" y1="' + (by + 1) + '" x2="' + (bx + 1) + '" y2="' + (by + bh - 1) + '" stroke="' + color + '" stroke-width="0.5" opacity="0.3"/>';
            // Number
            svg += '<text x="' + (bx + bw / 2) + '" y="' + (by + bh / 2 + 4) + '" text-anchor="middle" font-size="' + Math.min(12, bw * 0.25) + '" font-weight="700" fill="' + color + '">' + count + '</text>';
        }
    }

    // Dimension labels
    svg += '<text x="' + (ox + palletL * scale / 2) + '" y="' + (oy + palletW * scale + 16) + '" text-anchor="middle" font-size="11" font-weight="600" fill="#5D4037">' + palletL + '"</text>';
    svg += '<text x="' + (ox - 8) + '" y="' + (oy + palletW * scale / 2) + '" text-anchor="middle" font-size="11" font-weight="600" fill="#5D4037" transform="rotate(-90,' + (ox - 8) + ',' + (oy + palletW * scale / 2) + ')">' + palletW + '"</text>';

    svg += '</svg>';
    this.$container.find(".dle-pallet-topdown").html(svg);
};

DieLayoutEditor.prototype._renderPallet3D = function (best, boxH, layers, palletL, palletW) {
    // Isometric 3D using stacked SVG layers
    var maxDim = Math.max(palletL, palletW, layers * boxH);
    var sc = Math.min(300 / maxDim, 4);
    var isoX = 0.7, isoY = 0.4; // isometric projection factors
    var svgW = 500, svgH = 400;

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '" style="max-width:100%;">';
    var cx = svgW * 0.45, cy = svgH * 0.85;

    // Helper: project 3D to isometric 2D
    function iso(x, y, z) {
        return {
            x: cx + (x - y) * isoX * sc,
            y: cy - z * sc - (x + y) * isoY * sc
        };
    }

    // Draw pallet deck
    var p1 = iso(0, 0, 0), p2 = iso(palletL, 0, 0), p3 = iso(palletL, palletW, 0), p4 = iso(0, palletW, 0);
    svg += '<polygon points="' + p1.x + ',' + p1.y + ' ' + p2.x + ',' + p2.y + ' ' + p3.x + ',' + p3.y + ' ' + p4.x + ',' + p4.y + '" fill="#8D6E63" stroke="#5D4037" stroke-width="1.5"/>';

    // Pallet legs
    var legH = 6;
    var p1b = iso(0, 0, -legH), p2b = iso(palletL, 0, -legH);
    svg += '<polygon points="' + p1.x + ',' + p1.y + ' ' + p2.x + ',' + p2.y + ' ' + p2b.x + ',' + p2b.y + ' ' + p1b.x + ',' + p1b.y + '" fill="#6D4C41" stroke="#5D4037" stroke-width="0.5"/>';
    var p2c = iso(palletL, palletW, -legH);
    svg += '<polygon points="' + p2.x + ',' + p2.y + ' ' + p3.x + ',' + p3.y + ' ' + p2c.x + ',' + p2c.y + ' ' + p2b.x + ',' + p2b.y + '" fill="#795548" stroke="#5D4037" stroke-width="0.5"/>';

    // Draw box layers
    var colors = ["#4FC3F7", "#81C784", "#FFB74D", "#BA68C8", "#E57373"];
    var maxLayersShow = Math.min(layers, 12); // limit to 12 for performance

    for (var layer = 0; layer < maxLayersShow; layer++) {
        var z0 = layer * boxH;
        var layerColor = colors[layer % colors.length];
        var darkerColor = colors[(layer + 2) % colors.length];

        for (var r = 0; r < best.down; r++) {
            for (var c = 0; c < best.across; c++) {
                var bx0 = c * best.bL;
                var by0 = r * best.bW;

                // Top face
                var t1 = iso(bx0, by0, z0 + boxH);
                var t2 = iso(bx0 + best.bL, by0, z0 + boxH);
                var t3 = iso(bx0 + best.bL, by0 + best.bW, z0 + boxH);
                var t4 = iso(bx0, by0 + best.bW, z0 + boxH);
                svg += '<polygon points="' + t1.x + ',' + t1.y + ' ' + t2.x + ',' + t2.y + ' ' + t3.x + ',' + t3.y + ' ' + t4.x + ',' + t4.y + '" fill="' + layerColor + '" fill-opacity="0.7" stroke="rgba(0,0,0,0.2)" stroke-width="0.5"/>';

                // Front face (visible)
                var f1 = iso(bx0, by0, z0);
                var f2 = iso(bx0 + best.bL, by0, z0);
                svg += '<polygon points="' + f1.x + ',' + f1.y + ' ' + f2.x + ',' + f2.y + ' ' + t2.x + ',' + t2.y + ' ' + t1.x + ',' + t1.y + '" fill="' + darkerColor + '" fill-opacity="0.5" stroke="rgba(0,0,0,0.15)" stroke-width="0.5"/>';

                // Right face (visible)
                var r1 = iso(bx0 + best.bL, by0 + best.bW, z0);
                svg += '<polygon points="' + f2.x + ',' + f2.y + ' ' + r1.x + ',' + r1.y + ' ' + t3.x + ',' + t3.y + ' ' + t2.x + ',' + t2.y + '" fill="' + layerColor + '" fill-opacity="0.4" stroke="rgba(0,0,0,0.15)" stroke-width="0.5"/>';
            }
        }
    }

    // Layer count label
    svg += '<text x="' + (svgW - 10) + '" y="20" text-anchor="end" font-size="12" font-weight="700" fill="#fff">' + layers + ' layers</text>';
    svg += '<text x="' + (svgW - 10) + '" y="36" text-anchor="end" font-size="10" fill="#ccc">' + (best.total * layers) + ' boxes total</text>';

    svg += '</svg>';
    this.$container.find(".dle-pallet-3d").html(svg);
};

// ═══════════════════════════════════════════════════════════════════════════
//  DXF IMPORT — Upload and parse DXF file
// ═══════════════════════════════════════════════════════════════════════════

DieLayoutEditor.prototype._importCAD = function () {
    var self = this;
    var supported = [".dxf", ".svg", ".ai", ".eps", ".pdf"];

    // Use Frappe's file upload dialog
    new frappe.ui.FileUploader({
        doctype: "Die Layout",
        docname: self.layoutName || undefined,
        restrictions: {
            allowed_file_types: supported,
        },
        on_success: function (file_doc) {
            var file_url = file_doc.file_url;
            var ext = file_url.split(".").pop().toLowerCase();
            var formatName = {dxf: "DXF", svg: "SVG", ai: "Adobe Illustrator", eps: "EPS", pdf: "PDF"}[ext] || ext.toUpperCase();

            frappe.show_alert({ message: formatName + " uploaded. Parsing vectors...", indicator: "blue" });

            // Use unified import_file for all formats (falls back to import_dxf for .dxf)
            frappe.call({
                method: "libracad.api.import_file",
                args: { file_url: file_url },
                freeze: true,
                freeze_message: "Importing " + formatName + " — parsing geometry, creating estimate and die layout...",
                callback: function (r) {
                    if (r.message && r.message.success) {
                        var d = r.message;
                        frappe.msgprint({
                            title: formatName + " Import Successful",
                            indicator: "green",
                            message: [
                                "<b>Source:</b> " + formatName + " file",
                                "<b>Estimate:</b> " + d.estimate_name,
                                "<b>Die Layout:</b> " + d.layout_name,
                                "<b>Blank:</b> " + d.blank_length + '" x ' + d.blank_width + '"',
                                "<b>Detected Style:</b> " + d.detected_style,
                                "<b>Layers:</b> " + (d.layers_found || []).join(", "),
                                "<b>Entities:</b> " + d.total_entities,
                                "",
                                '<a href="/app/die-layout-editor?layout=' + d.layout_name + '">Open in Editor</a>',
                            ].join("<br>"),
                        });

                        // Navigate to the new layout
                        self.layoutName = d.layout_name;
                        self._loadLayout(d.layout_name);
                    }
                },
                error: function () {
                    frappe.msgprint({
                        title: "Import Failed", indicator: "red",
                        message: "Could not parse the " + formatName + " file. Supported formats: " + supported.join(", ") +
                            ". For EPS/AI files, try converting to SVG first.",
                    });
                },
            });
        },
    });
};
