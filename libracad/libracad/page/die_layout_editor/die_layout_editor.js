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
    if (layoutName && layoutName !== this.layoutName) {
        this.layoutName = layoutName;
        this._loadLayout(layoutName);
    }
    // Clear route_options so they don't persist
    frappe.route_options = null;
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
    } else {
        // Default to RSC
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
