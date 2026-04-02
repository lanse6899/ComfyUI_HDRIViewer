/**
 * ComfyUI Panorama Viewer - Frontend Extension
 * Three.js-based interactive 360-degree panorama viewer with sphere projection.
 */

import { app } from "../../scripts/app.js";
import * as THREE from "./lib/three.module.min.js";

/** ComfyUI often serializes long UI strings as char arrays. */
function comfyUiString(value) {
    if (value == null) return "";
    if (Array.isArray(value)) return value.join("");
    return String(value);
}

app.registerExtension({
    name: "ComfyUI.PanoramaViewer",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "PanoramaViewer") return;
        console.log("[PanoramaViewer] Registering node");

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        const origOnExecuted = nodeType.prototype.onExecuted;
        const origOnRemoved = nodeType.prototype.onRemoved;
        const origOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        const origOnWidgetChanged = nodeType.prototype.onWidgetChanged;

        // ── Node created: build Three.js viewer panel ──────────────────────
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated?.apply(this, arguments);
            this._buildThreePanel();
            return r;
        };

        // ── Node executed: receive base64 data URL ──────────────────────────
        nodeType.prototype.onExecuted = function (message) {
            const r = origOnExecuted?.apply(this, arguments);
            let dataUrl = "";
            if (message?.pano_image) {
                dataUrl = comfyUiString(message.pano_image);
            } else if (message?.ui?.pano_image) {
                dataUrl = comfyUiString(message.ui.pano_image);
            }
            if (dataUrl) {
                this._pvLoadImage(dataUrl);
            }
            return r;
        };

        // ── Node removed: dispose Three.js resources ────────────────────────
        nodeType.prototype.onRemoved = function () {
            this._pvDispose?.();
            return origOnRemoved?.apply(this, arguments);
        };

        // ── Widget changed: update projection / FOV / auto-rotate ─────────
        nodeType.prototype.onWidgetChanged = function (name, value) {
            origOnWidgetChanged?.apply(this, arguments);
            const pv = this._pv;
            if (!pv) return;
            if (name === "projection_mode") {
                pv.projectionMode = value;
                pv._updateGeometry();
            } else if (name === "fov") {
                pv.camera.fov = value;
                pv.camera.updateProjectionMatrix();
                this._pvUpdateInfo?.();
            } else if (name === "auto_rotate") {
                pv.autoRotate = value;
                if (value) pv._startAutoRotate();
                else pv._stopAutoRotate();
            } else if (name === "rotation_speed") {
                pv.rotationSpeed = value;
            }
        };
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Three.js viewer helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build sphere geometry with UVs for equirectangular mapping. */
function buildSphereGeo(radius, latBands, lonBands) {
    const positions = [], uvs = [], indices = [];
    for (let lat = 0; lat <= latBands; lat++) {
        const theta = (lat * Math.PI) / latBands;
        const sinT = Math.sin(theta), cosT = Math.cos(theta);
        for (let lon = 0; lon <= lonBands; lon++) {
            const phi = (lon * 2 * Math.PI) / lonBands;
            positions.push(
                -Math.cos(phi) * sinT * radius,
                cosT * radius,
                Math.sin(phi) * sinT * radius
            );
            uvs.push(lon / lonBands, lat / latBands);
        }
    }
    for (let lat = 0; lat < latBands; lat++) {
        for (let lon = 0; lon < lonBands; lon++) {
            const a = lat * (lonBands + 1) + lon;
            const b = a + lonBands + 1;
            indices.push(a, a + 1, b, b, a + 1, b + 1);
        }
    }
    return {
        positions: new Float32Array(positions),
        uvs: new Float32Array(uvs),
        indices: new Uint16Array(indices)
    };
}

/** Build cylinder geometry for cylindrical projection. */
function buildCylGeo(radius, height, lonBands, hBands) {
    const positions = [], uvs = [], indices = [];
    const h2 = height / 2;
    for (let band = 0; band <= hBands; band++) {
        const v = band / hBands;
        const y = (v - 0.5) * height;
        for (let lon = 0; lon <= lonBands; lon++) {
            const phi = (lon * 2 * Math.PI) / lonBands;
            positions.push(-Math.cos(phi) * radius, y, Math.sin(phi) * radius);
            uvs.push(lon / lonBands, v);
        }
    }
    for (let band = 0; band < hBands; band++) {
        for (let lon = 0; lon < lonBands; lon++) {
            const a = band * (lonBands + 1) + lon;
            const b = a + lonBands + 1;
            indices.push(a, a + 1, b, b, a + 1, b + 1);
        }
    }
    return {
        positions: new Float32Array(positions),
        uvs: new Float32Array(uvs),
        indices: new Uint16Array(indices)
    };
}

function makeVBO(gl, data) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
}
function makeIBO(gl, data) {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
}

// ─────────────────────────────────────────────────────────────────────────────
//  LGraphNode prototype extensions
// ─────────────────────────────────────────────────────────────────────────────

Object.assign(LGraphNode.prototype, {

    /** Build the Three.js panorama panel and wire all controls. */
    _buildThreePanel() {
        console.log("[PanoramaViewer] Building Three.js panel");

        // ── DOM structure ─────────────────────────────────────────────────
        const container = document.createElement("div");
        container.style.cssText = `
            width:100%; min-height:320px; height:320px;
            border:2px solid #555; border-radius:6px;
            background:#000; margin:5px 0;
            display:flex; flex-direction:column;
            box-sizing:border-box; overflow:hidden; position:relative;
        `;

        const canvasArea = document.createElement("div");
        canvasArea.style.cssText = `
            flex:1; position:relative; background:#000;
            display:flex; align-items:center; justify-content:center;
            cursor:grab; overflow:hidden;
        `;
        container.appendChild(canvasArea);

        // ── Control bar ──────────────────────────────────────────────────
        const bar = document.createElement("div");
        bar.style.cssText = `
            background:#1e1e1e; padding:5px 10px;
            border-top:1px solid #333;
            font-size:11px; color:#ccc;
            display:flex; flex-wrap:wrap; gap:8px;
            align-items:center; user-select:none;
        `;
        bar.innerHTML = `
            <span id="pv-yaw">Yaw:0°</span>
            <span id="pv-pitch">Pitch:0°</span>
            <span id="pv-fov">FOV:75°</span>
            <select id="pv-mode" style="padding:2px 6px;background:#2a2a2a;border:1px solid #444;color:#ccc;border-radius:3px;font-size:11px;">
                <option value="sphere">Sphere</option>
                <option value="equirectangular">Equirectangular</option>
                <option value="cylinder">Cylinder</option>
            </select>
            <label style="display:flex;align-items:center;gap:3px;cursor:pointer;">
                <input type="checkbox" id="pv-auto">
                <span>Auto</span>
            </label>
            <button id="pv-reset" style="padding:2px 8px;background:#2a2a2a;border:1px solid #444;border-radius:3px;color:#ccc;cursor:pointer;font-size:11px;">Reset</button>
        `;
        container.appendChild(bar);

        // ── DOM widget ────────────────────────────────────────────────────
        this.addDOMWidget("panorama_panel", "div", container);

        // ── Three.js setup ────────────────────────────────────────────────
        const canvas = document.createElement("canvas");
        canvas.style.cssText = "width:100%;height:100%;display:block;";
        canvasArea.appendChild(canvas);

        const gl = canvas.getContext("webgl", { antialias: true, alpha: false });
        if (!gl) {
            console.error("[PanoramaViewer] WebGL not supported");
            return;
        }

        gl.clearColor(0, 0, 0, 1);
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);

        // ── Minimal shaders (no matrix lib needed) ─────────────────────────
        const VS = `
            attribute vec3 aPos;
            attribute vec2 aUV;
            uniform mat4 uMVP;
            varying vec2 vUV;
            void main() {
                vUV = aUV;
                gl_Position = uMVP * vec4(aPos, 1.0);
            }
        `;
        const FS = `
            precision highp float;
            uniform sampler2D uTex;
            uniform int uProjMode;
            varying vec2 vUV;
            void main() {
                vec4 col = texture2D(uTex, vUV);
                gl_FragColor = col;
            }
        `;
        const BG_VS = `attribute vec2 aPos; varying vec2 vUV; void main(){ vUV=aPos*0.5+0.5; gl_Position=vec4(aPos,0.0,1.0); }`;
        const BG_FS = `precision highp float; void main(){ gl_FragColor=vec4(0.02,0.02,0.04,1.0); }`;

        function mkProg(vs, fs) {
            function mkSh(t, src) {
                const s = gl.createShader(t);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                    console.error("Shader:", gl.getShaderInfoLog(s), src);
                return s;
            }
            const p = gl.createProgram();
            gl.attachShader(p, mkSh(gl.VERTEX_SHADER, vs));
            gl.attachShader(p, mkSh(gl.FRAGMENT_SHADER, fs));
            gl.linkProgram(p);
            if (!gl.getProgramParameter(p, gl.LINK_STATUS))
                console.error("Program:", gl.getProgramInfoLog(p));
            return p;
        }

        const prog = mkProg(VS, FS);
        const progBg = mkProg(BG_VS, BG_FS);

        const aPos = gl.getAttribLocation(prog, "aPos");
        const aUV = gl.getAttribLocation(prog, "aUV");
        const uMVP = gl.getUniformLocation(prog, "uMVP");
        const uTex = gl.getUniformLocation(prog, "uTex");

        // Geometry buffers
        const sphereGeo = buildSphereGeo(500, 48, 96);
        const cylGeo = buildCylGeo(500, 600, 96, 32);
        const bgBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

        function makeGeoBuffers(geo) {
            return {
                pos: makeVBO(gl, geo.positions),
                uv: makeVBO(gl, geo.uvs),
                idx: makeIBO(gl, geo.indices),
                count: geo.indices.length
            };
        }
        const sphereBuf = makeGeoBuffers(sphereGeo);
        const cylBuf = makeGeoBuffers(cylGeo);

        // Texture
        let tex = null;
        function loadTex(url, cb) {
            const t = gl.createTexture();
            const img = new Image();
            img.onload = () => {
                gl.bindTexture(gl.TEXTURE_2D, t);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                tex = t;
                cb();
            };
            img.onerror = () => { gl.deleteTexture(t); cb(); };
            img.src = url;
        }

        // Camera
        const camera = { yaw: 0, pitch: 0, fov: 75, aspect: 1 };
        let animId = null;

        // Matrices (column-major, Float32Array)
        function m4Persp(fov, aspect, near, far) {
            const f = 1 / Math.tan(fov / 2);
            return new Float32Array([
                f/aspect, 0, 0, 0,
                0, f, 0, 0,
                0, 0, (far+near)/(near-far), -1,
                0, 0, (2*far*near)/(near-far), 0
            ]);
        }
        function m4RotY(a) {
            const c = Math.cos(a), s = Math.sin(a);
            return new Float32Array([c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]);
        }
        function m4RotX(a) {
            const c = Math.cos(a), s = Math.sin(a);
            return new Float32Array([1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1]);
        }
        function m4Mul(a, b) {
            const o = new Float32Array(16);
            for (let i=0;i<4;i++) for (let j=0;j<4;j++)
                o[j*4+i]=a[i]*b[j*4]+a[4+i]*b[j*4+1]+a[8+i]*b[j*4+2]+a[12+i]*b[j*4+3];
            return o;
        }

        // State
        const pv = {
            gl, canvas, prog, progBg,
            aPos, aUV, uMVP, uTex,
            sphereBuf, cylBuf,
            camera, tex,
            yaw: 0, pitch: 0, fov: 75,
            autoRotate: false,
            rotationSpeed: 0.5,
            projectionMode: "sphere",
            animId, bgBuf,
            // Callbacks stored on node
            node: this,
            _updateGeometry() { /* geometry switching handled in render */ },
            _startAutoRotate() { /* handled in render loop */ },
            _stopAutoRotate() { /* handled in render loop */ },
        };

        this._pv = pv;
        this._pvUpdateInfo = updateInfo;
        this._pvLoadImage = loadImg;
        this._pvReloadInput = reloadInput;
        this._pvDispose = dispose;

        // ── Resize ────────────────────────────────────────────────────────
        function resize() {
            const w = canvasArea.clientWidth, h = canvasArea.clientHeight;
            if (w === 0 || h === 0) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            canvas.style.width = w + "px";
            canvas.style.height = h + "px";
            pv.camera.aspect = w / h;
        }

        // ── Render loop ───────────────────────────────────────────────────
        let lastTime = 0;
        function render(ts) {
            animId = requestAnimationFrame(render);
            const dt = Math.min((ts - lastTime) / 1000, 0.1);
            lastTime = ts;

            if (pv.autoRotate) {
                pv.camera.yaw = (pv.camera.yaw + pv.rotationSpeed * dt * 20 + 360) % 360;
            }

            const W = canvas.width, H = canvas.height;
            gl.viewport(0, 0, W, H);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

            const fovRad = pv.camera.fov * Math.PI / 180;
            const proj = m4Persp(fovRad, pv.camera.aspect, 0.1, 2000);
            const yawR = m4RotY(-pv.camera.yaw * Math.PI / 180);
            const pitchR = m4RotX(-pv.camera.pitch * Math.PI / 180);
            const mvp = m4Mul(proj, m4Mul(pitchR, yawR));

            // Background
            gl.disable(gl.DEPTH_TEST);
            gl.useProgram(progBg);
            const loc = gl.getAttribLocation(progBg, "aPos");
            gl.bindBuffer(gl.ARRAY_BUFFER, bgBuf);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            // Panorama
            if (tex) {
                gl.enable(gl.DEPTH_TEST);
                gl.cullFace(gl.BACK);
                gl.useProgram(prog);

                const buf = pv.projectionMode === "cylinder" ? cylBuf : sphereBuf;
                gl.bindBuffer(gl.ARRAY_BUFFER, buf.pos);
                gl.enableVertexAttribArray(aPos);
                gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);

                gl.bindBuffer(gl.ARRAY_BUFFER, buf.uv);
                gl.enableVertexAttribArray(aUV);
                gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);

                gl.uniformMatrix4fv(uMVP, false, mvp);
                gl.uniform1i(uTex, 0);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf.idx);
                gl.drawElements(gl.TRIANGLES, buf.count, gl.UNSIGNED_SHORT, 0);
            }

            updateInfo();
        }

        // ── Info display ──────────────────────────────────────────────────
        function updateInfo() {
            const yEl = bar.querySelector("#pv-yaw");
            const pEl = bar.querySelector("#pv-pitch");
            const fEl = bar.querySelector("#pv-fov");
            if (yEl) yEl.textContent = `Yaw:${Math.round(pv.camera.yaw)}°`;
            if (pEl) pEl.textContent = `Pitch:${Math.round(pv.camera.pitch)}°`;
            if (fEl) fEl.textContent = `FOV:${pv.camera.fov}°`;
        }

        // ── Load image ────────────────────────────────────────────────────
        function loadImg(dataUrl) {
            if (!gl || !dataUrl) return;
            loadTex(dataUrl, () => {
                resize();
            });
        }

        // ── Reload from graph (fallback) ─────────────────────────────────
        function reloadInput() {
            const imageInput = this.inputs?.find(i => i.name === "image");
            if (!imageInput?.link) return;
            const link = app.graph.links[imageInput.link];
            if (!link) return;
            const src = app.graph.getNodeById(link.origin_id);
            if (!src) return;

            let url = null;
            // Try last output data
            if (this.lastOutputData) {
                url = this.lastOutputData;
            }
            // Try source node images
            else if (src.images?.length > 0) {
                const img = src.images[0];
                if (img.filename)
                    url = `/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder||"")}&type=${img.type||"output"}`;
            } else if (src.imgs?.length > 0) {
                const img = src.imgs[0];
                if (img?.src) url = img.src;
                else if (img?._src) url = img._src;
            }
            if (url) loadImg(url);
        }

        // ── Dispose ────────────────────────────────────────────────────────
        function dispose() {
            if (animId) cancelAnimationFrame(animId);
            resizeObs?.disconnect();
            // Mouse/touch listeners removed via reference stored below
        }

        // ── Controls ───────────────────────────────────────────────────────
        const modeSel = bar.querySelector("#pv-mode");
        const autoCheck = bar.querySelector("#pv-auto");
        const resetBtn = bar.querySelector("#pv-reset");

        modeSel?.addEventListener("change", (e) => {
            pv.projectionMode = e.target.value;
            this.updateWidgetValue?.("projection_mode", e.target.value);
        });

        autoCheck?.addEventListener("change", (e) => {
            pv.autoRotate = e.target.checked;
            this.updateWidgetValue?.("auto_rotate", e.target.checked);
        });

        resetBtn?.addEventListener("click", () => {
            pv.camera.yaw = 0;
            pv.camera.pitch = 0;
            pv.camera.fov = 75;
            pv.autoRotate = false;
            autoCheck && (autoCheck.checked = false);
            this.updateWidgetValue?.("fov", 75);
            this.updateWidgetValue?.("auto_rotate", false);
        });

        // ── Mouse / touch interaction ─────────────────────────────────────
        let dragging = false, lastX = 0, lastY = 0;

        canvasArea.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            dragging = true;
            lastX = e.clientX; lastY = e.clientY;
            canvasArea.style.cursor = "grabbing";
        });
        window.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            const dx = e.clientX - lastX, dy = e.clientY - lastY;
            lastX = e.clientX; lastY = e.clientY;
            pv.camera.yaw = (pv.camera.yaw - dx * 0.3 + 3600) % 360;
            pv.camera.pitch = Math.max(-85, Math.min(85, pv.camera.pitch - dy * 0.3));
        });
        window.addEventListener("mouseup", () => {
            dragging = false;
            canvasArea.style.cursor = "grab";
        });

        canvasArea.addEventListener("touchstart", (e) => {
            if (e.touches.length === 1) {
                dragging = true;
                lastX = e.touches[0].clientX;
                lastY = e.touches[0].clientY;
            }
        }, { passive: true });
        canvasArea.addEventListener("touchmove", (e) => {
            if (!dragging || e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - lastX;
            const dy = e.touches[0].clientY - lastY;
            lastX = e.touches[0].clientX; lastY = e.touches[0].clientY;
            pv.camera.yaw = (pv.camera.yaw - dx * 0.3 + 3600) % 360;
            pv.camera.pitch = Math.max(-85, Math.min(85, pv.camera.pitch - dy * 0.3));
        }, { passive: true });
        canvasArea.addEventListener("touchend", () => { dragging = false; });

        // Wheel for FOV
        canvasArea.addEventListener("wheel", (e) => {
            e.preventDefault();
            pv.camera.fov = Math.max(30, Math.min(120, pv.camera.fov + (e.deltaY > 0 ? -5 : 5)));
            this.updateWidgetValue?.("fov", Math.round(pv.camera.fov));
        }, { passive: false });

        // Double-click to reset
        canvasArea.addEventListener("dblclick", () => {
            pv.camera.yaw = 0; pv.camera.pitch = 0; pv.camera.fov = 75;
            autoCheck && (autoCheck.checked = false);
            pv.autoRotate = false;
        });

        // ── Resize observer ───────────────────────────────────────────────
        let resizeObs = null;
        resizeObs = new ResizeObserver(() => resize());
        resizeObs.observe(canvasArea);

        // ── Start render ──────────────────────────────────────────────────
        resize();
        animId = requestAnimationFrame(render);

        // ── Sync mode select with widget value ───────────────────────────
        const modeWidget = this.widgets?.find(w => w.name === "projection_mode");
        if (modeWidget && modeSel) modeSel.value = modeWidget.value || "sphere";

        // ── Load input image after creation ───────────────────────────────
        setTimeout(() => reloadInput.call(this), 500);
    }
});
