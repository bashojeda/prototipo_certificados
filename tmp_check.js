
    (function() {
        if (!window.pdfjsLib) {
            alert("No se pudo cargar pdf.js desde CDN.");
            throw new Error("pdfjsLib no disponible");
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

        const rawDatosData = {"a":1};
        const datosData = (typeof rawDatosData === "string") ? JSON.parse(rawDatosData) : rawDatosData;
        const previewParams = new URLSearchParams(datosData).toString();
        const pdfUrlBase = `/preview/sess/row`;
        const rawImagenesData = [];
        const initialImagenes = Array.isArray(rawImagenesData) ? rawImagenesData : [];
        const state = {
            pdfDoc: null,
            currentPage: 1,
            zoom: 0.8,
            fitScale: 1.0,
            renderSeq: 0,
            renderQueue: Promise.resolve(),
            pageWidthIn: parseFloat('8.27') || 8.27,
            pageHeightIn: parseFloat('11.69') || 11.69,
            active: initialImagenes.length ? initialImagenes[0].filename : null,
            images: initialImagenes.map((item, index) => ({
                key: item.filename || `imagen_${index}`,
                label: item.original_name || item.filename || `Imagen ${index + 1}`,
                src: item.src || `/uploads/${item.filename}`,
                filename: item.filename,
                original_name: item.original_name || item.filename,
                x: parseFloat(item.x || 0) || 0,
                y: parseFloat(item.y || 0) || 0,
                width: parseFloat(item.width || 2.5) || 2.5,
                page: parseInt(item.page || 1, 10) || 1,
            })),
            lastSavedImages: [],
        };

        const canvas = document.getElementById("pdf-canvas");
        const overlayLayer = document.getElementById("overlay-layer");
        const stage = document.getElementById("stage");
        const viewerPanel = document.querySelector(".viewer-panel");
        const activeElementSelect = document.getElementById("active-element");
        const coordX = document.getElementById("coord-x");
        const coordY = document.getElementById("coord-y");
        const coordPage = document.getElementById("coord-page");
        const coordWidth = document.getElementById("coord-width");
        const pageLabel = document.getElementById("page-label");
        const zoomRange = document.getElementById("zoom-range");
        const zoomLabel = document.getElementById("zoom-label");
        const saveStatus = document.getElementById("save-status");
        const imageList = document.getElementById("image-list");
        const uploadInput = document.getElementById("upload-images");
        const uploadStatus = document.getElementById("upload-status");

        const itemEls = {};

        function getImageHeightIn(image) {
            const img = itemEls[image.key]?.querySelector("img");
            if (!img || !img.naturalWidth || !img.naturalHeight) return image.width;
            return image.width * (img.naturalHeight / img.naturalWidth);
        }

        function inchesToPxX(inches) { return (inches / state.pageWidthIn) * canvas.clientWidth; }
        function inchesToPxY(inches) { return (inches / state.pageHeightIn) * canvas.clientHeight; }
        function pxToInchesX(px) { return (px / canvas.clientWidth) * state.pageWidthIn; }
        function pxToInchesY(px) { return (px / canvas.clientHeight) * state.pageHeightIn; }

        function syncForm() {
            const output = state.images.map((item) => ({
                filename: item.filename,
                original_name: item.original_name,
                x: item.x,
                y: item.y,
                width: item.width,
                page: item.page,
            }));
            document.getElementById("imagenes_json").value = JSON.stringify(output);
        }

        function setSaving(active) {
            const loading = document.getElementById('loading-overlay');
            const controls = [
                document.getElementById('guardar-btn'),
                document.getElementById('restablecer-btn'),
                document.getElementById('upload-images-btn'),
                uploadInput,
                activeElementSelect,
                document.getElementById('prev-page'),
                document.getElementById('next-page'),
            ];
            controls.forEach((el) => {
                if (!el) return;
                el.disabled = active;
            });
            if (active) {
                loading.classList.add('active');
            } else {
                loading.classList.remove('active');
            }
        }

        function removeImage(key) {
            const idx = state.images.findIndex((item) => item.key === key);
            if (idx === -1) return;
            const removed = state.images.splice(idx, 1)[0];
            const element = itemEls[key];
            if (element && element.parentNode) {
                element.parentNode.removeChild(element);
            }
            delete itemEls[key];
            if (state.active === key) {
                state.active = state.images.length ? state.images[0].key : null;
            }
            renderImageList();
            updateAllOverlays();
        }

        function getCurrentImage() {
            return state.images.find((item) => item.key === state.active) || state.images[0] || null;
        }

        function renderImageList() {
            imageList.innerHTML = "";
            state.images.forEach((image) => {
                const card = document.createElement("div");
                card.className = "thumbnail-card";
                if (state.active === image.key) {
                    card.classList.add("active");
                }
                card.draggable = true;
                card.dataset.key = image.key;

                const thumb = document.createElement("img");
                thumb.src = image.src;
                thumb.alt = image.label;
                card.appendChild(thumb);

                const label = document.createElement("span");
                label.textContent = image.label;
                card.appendChild(label);

                const removeBtn = document.createElement("button");
                removeBtn.type = "button";
                removeBtn.className = "remove-btn";
                removeBtn.textContent = "Eliminar";
                removeBtn.title = "Eliminar imagen";
                removeBtn.addEventListener("click", (ev) => {
                    ev.stopPropagation();
                    removeImage(image.key);
                });
                card.appendChild(removeBtn);

                card.addEventListener("click", () => {
                    state.active = image.key;
                    updateAllOverlays();
                    renderImageList();
                });

                card.addEventListener("dragstart", (ev) => {
                    ev.dataTransfer.setData("text/plain", image.key);
                    ev.dataTransfer.effectAllowed = "move";
                    state.active = image.key;
                    updateAllOverlays();
                });

                imageList.appendChild(card);
            });
        }

        function spreadInitialPositions() {
            const unplaced = state.images.filter((item) => item.x === 0 && item.y === 0);
            if (state.images.length > 1 && unplaced.length > 1) {
                unplaced.forEach((item, index) => {
                    item.x = 0.5 + (index % 3) * 2.8;
                    item.y = 0.5 + Math.floor(index / 3) * 2.8;
                    item.page = 1;
                });
            }
        }

        function copySavedPositions() {
            state.lastSavedImages = state.images.map((item) => ({
                filename: item.filename,
                original_name: item.original_name,
                src: item.src,
                x: item.x,
                y: item.y,
                width: item.width,
                page: item.page,
                key: item.key,
            }));
        }

        function restoreLastSavedPositions() {
            const savedByKey = {};
            state.lastSavedImages.forEach((item) => {
                savedByKey[item.key] = item;
            });
            state.images = state.images.map((item) => {
                if (savedByKey[item.key]) {
                    return {
                        ...item,
                        x: savedByKey[item.key].x,
                        y: savedByKey[item.key].y,
                        width: savedByKey[item.key].width,
                        page: savedByKey[item.key].page,
                    };
                }
                return item;
            });
            updateAllOverlays();
            renderImageList();
        }

        function refreshSideControls() {
            const p = getCurrentImage();
            if (!p) return;
            coordX.textContent = p.x.toFixed(2);
            coordY.textContent = p.y.toFixed(2);
            coordPage.value = p.page;
            coordWidth.value = p.width.toFixed(2);
        }

        function positionItem(image) {
            const el = itemEls[image.key];
            if (!el || !image.src) return;
            if (image.page !== state.currentPage) {
                el.style.display = "none";
                return;
            }
            el.style.display = "block";
            el.classList.toggle("active", state.active === image.key);
            const widthPx = Math.max(24, inchesToPxX(image.width));
            const heightPx = Math.max(24, inchesToPxY(getImageHeightIn(image)));
            const left = Math.max(0, Math.min(inchesToPxX(image.x), canvas.clientWidth - widthPx));
            const top = Math.max(0, Math.min(inchesToPxY(image.y), canvas.clientHeight - heightPx));
            el.style.width = `${widthPx}px`;
            el.style.height = `${heightPx}px`;
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
        }

        function updateAllOverlays() {
            state.images.forEach(positionItem);
            refreshSideControls();
            syncForm();
        }

        function calcularFitScale(viewportBase) {
            const panelRect = viewerPanel.getBoundingClientRect();
            const panelW = panelRect.width;
            const panelH = panelRect.height;
            const maxW = Math.max(240, panelW * 0.95);
            const maxH = Math.max(240, panelH * 0.95);
            return Math.min(maxW / viewportBase.width, maxH / viewportBase.height, 1.0);
        }

        function attachDragAndResize(name, el) {
            const handle = document.createElement("div");
            handle.className = "resize-handle";
            el.appendChild(handle);

            el.addEventListener("pointerdown", (e) => {
                if (e.target === handle) return;
                state.active = name;
                const startX = e.clientX;
                const startY = e.clientY;
                const startLeft = parseFloat(el.style.left || "0");
                const startTop = parseFloat(el.style.top || "0");
                const image = state.images.find((item) => item.key === name);
                if (!image) return;
                image.page = state.currentPage;
                function onMove(ev) {
                    const nextLeft = Math.max(0, Math.min(startLeft + (ev.clientX - startX), canvas.clientWidth - el.offsetWidth));
                    const nextTop = Math.max(0, Math.min(startTop + (ev.clientY - startY), canvas.clientHeight - el.offsetHeight));
                    el.style.left = `${nextLeft}px`;
                    el.style.top = `${nextTop}px`;
                    image.x = pxToInchesX(nextLeft);
                    image.y = pxToInchesY(nextTop);
                    refreshSideControls();
                    syncForm();
                }
                function onUp() {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    updateAllOverlays();
                }
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
            });

            handle.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                state.active = name;
                const startX = e.clientX;
                const startWidth = el.offsetWidth;
                const image = state.images.find((item) => item.key === name);
                if (!image) return;
                image.page = state.currentPage;
                function onMove(ev) {
                    const nextWidth = Math.max(24, startWidth + (ev.clientX - startX));
                    const maxWidth = canvas.clientWidth - parseFloat(el.style.left || "0");
                    const clampedWidth = Math.min(nextWidth, maxWidth);
                    image.width = Math.max(0.1, pxToInchesX(clampedWidth));
                    positionItem(image);
                    refreshSideControls();
                    syncForm();
                }
                function onUp() {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    updateAllOverlays();
                }
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
            });
        }

        async function renderPage(pageNum) {
            const renderId = ++state.renderSeq;
            const page = await state.pdfDoc.getPage(pageNum);
            const viewportBase = page.getViewport({ scale: 1.0 });
            state.fitScale = calcularFitScale(viewportBase);
            const viewport = page.getViewport({ scale: state.fitScale * state.zoom });
            const dpr = window.devicePixelRatio || 1;
            const cssWidth = Math.floor(viewport.width);
            const cssHeight = Math.floor(viewport.height);
            canvas.width = Math.floor(cssWidth * dpr);
            canvas.height = Math.floor(cssHeight * dpr);
            canvas.style.width = `${cssWidth}px`;
            canvas.style.height = `${cssHeight}px`;
            stage.style.width = `${cssWidth}px`;
            stage.style.height = `${cssHeight}px`;
            overlayLayer.style.width = `${cssWidth}px`;
            overlayLayer.style.height = `${cssHeight}px`;

            state.pageWidthIn = viewportBase.width / 72.0;
            state.pageHeightIn = viewportBase.height / 72.0;

            const ctx = canvas.getContext("2d");
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            await page.render({ canvasContext: ctx, viewport }).promise;
            if (renderId !== state.renderSeq) return;
            stage.style.visibility = "visible";
            pageLabel.textContent = `Página ${state.currentPage} / ${state.pdfDoc.numPages}`;
            updateAllOverlays();
        }

        function goToPage(pageNum) {
            state.currentPage = Math.max(1, Math.min(pageNum, state.pdfDoc.numPages));
            scheduleRender(state.currentPage);
        }

        let zoomTimer = null;
        function renderPageDebounced() {
            if (zoomTimer) clearTimeout(zoomTimer);
            zoomTimer = setTimeout(() => {
                scheduleRender(state.currentPage);
            }, 140);
        }

        function scheduleRender(pageNum) {
            state.renderQueue = state.renderQueue
                .then(() => renderPage(pageNum))
                .catch((err) => {
                    console.error("Render error:", err);
                });
            return state.renderQueue;
        }

        function createItem(image) {
            if (!image.src) return;
            const el = document.createElement("div");
            el.className = "overlay-item";
            const img = document.createElement("img");
            img.src = image.src;
            img.alt = image.label;
            el.appendChild(img);
            overlayLayer.appendChild(el);
            itemEls[image.key] = el;
            attachDragAndResize(image.key, el);
            img.addEventListener("load", () => updateAllOverlays());
        }

        async function init() {
            spreadInitialPositions();
            renderImageList();
            state.images.forEach((image) => {
                const option = document.createElement("option");
                option.value = image.key;
                option.textContent = image.label;
                activeElementSelect.appendChild(option);
                createItem(image);
            });

            if (!activeElementSelect.options.length) {
                activeElementSelect.disabled = true;
            } else {
                activeElementSelect.value = state.active;
            }

            copySavedPositions();
            zoomRange.value = String(state.zoom);
            zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
            state.pdfDoc = await pdfjsLib.getDocument(`${pdfUrlBase}${pdfUrlBase.includes("?") ? "&" : "?"}t=${Date.now()}`).promise;
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            await scheduleRender(state.currentPage);
            setTimeout(() => {
                scheduleRender(state.currentPage);
            }, 120);

            document.getElementById("prev-page").addEventListener("click", () => goToPage(state.currentPage - 1));
            document.getElementById("next-page").addEventListener("click", () => goToPage(state.currentPage + 1));
            zoomRange.addEventListener("input", async () => {
                state.zoom = parseFloat(zoomRange.value);
                zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
                renderPageDebounced();
            });
            window.addEventListener("resize", async () => {
                await scheduleRender(state.currentPage);
            });
            activeElementSelect.addEventListener("change", () => {
                state.active = activeElementSelect.value;
                updateAllOverlays();
            });
            coordPage.addEventListener("change", () => {
                const p = getCurrentImage();
                if (!p) return;
                p.page = Math.max(1, parseInt(coordPage.value || "1", 10));
                goToPage(p.page);
            });
            coordWidth.addEventListener("input", () => {
                const p = getCurrentImage();
                if (!p) return;
                p.width = Math.max(0.1, parseFloat(coordWidth.value || "0.1"));
                updateAllOverlays();
            });

            document.getElementById("guardar-btn").addEventListener("click", async () => {
                syncForm();
                saveStatus.textContent = "Guardando...";
                setSaving(true);
                const formData = new FormData(document.getElementById("coord-form"));
                const res = await fetch("/session/ajustar-posicion", { method: "POST", body: formData });
                if (!res.ok) {
                    const errorTxt = await res.text();
                    saveStatus.textContent = "Error al guardar.";
                    alert(`No se pudo guardar la posicion. Detalle: ${errorTxt}`);
                    setSaving(false);
                    return;
                }
                const data = await res.json();
                saveStatus.textContent = data.message || "Posiciones guardadas.";
                copySavedPositions();
                // Refresca el PDF renderizado para evitar recarga manual de la pagina.
                state.pdfDoc = await pdfjsLib.getDocument(`${pdfUrlBase}${pdfUrlBase.includes("?") ? "&" : "?"}t=${Date.now()}`).promise;
                await scheduleRender(state.currentPage);
                setSaving(false);
            });

            uploadStatus.textContent = '';
            const uploadImages = async () => {
                if (!uploadInput.files.length) {
                    uploadStatus.textContent = 'Selecciona al menos una imagen.';
                    return;
                }
                const formData = new FormData();
                formData.append('session_id', 'sess');
                for (const file of uploadInput.files) {
                    formData.append('imagenes', file);
                }
                uploadStatus.textContent = 'Subiendo imágenes...';
                setSaving(true);
                try {
                    const res = await fetch('/session/subir-imagenes', {
                        method: 'POST',
                        body: formData,
                    });
                    const data = await res.json();
                    if (!res.ok) {
                        uploadStatus.textContent = data.message || 'Error al subir imágenes.';
                        setSaving(false);
                        return;
                    }
                    state.images = data.imagenes.map((item, index) => ({
                        key: item.filename || `imagen_${index}`,
                        label: item.original_name || item.filename || `Imagen ${index + 1}`,
                        src: item.src || `/uploads/${item.filename}`,
                        filename: item.filename,
                        original_name: item.original_name || item.filename,
                        x: parseFloat(item.x || 0) || 0,
                        y: parseFloat(item.y || 0) || 0,
                        width: parseFloat(item.width || 2.5) || 2.5,
                        page: parseInt(item.page || 1, 10) || 1,
                    }));
                    uploadStatus.textContent = 'Imágenes subidas correctamente.';
                    uploadInput.value = '';
                    renderImageList();
                    state.images.forEach((image) => {
                        if (!itemEls[image.key]) {
                            createItem(image);
                        }
                    });
                    spreadInitialPositions();
                    updateAllOverlays();
                } catch (err) {
                    console.error(err);
                    uploadStatus.textContent = 'No se pudo subir las imágenes. Intenta nuevamente.';
                }
                setSaving(false);
            };

            uploadInput.addEventListener('change', uploadImages);
            document.getElementById("upload-images-btn").addEventListener("click", uploadImages);

            overlayLayer.addEventListener('dragover', (event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            });
            overlayLayer.addEventListener('drop', (event) => {
                event.preventDefault();
                const key = event.dataTransfer.getData('text/plain');
                const image = state.images.find((item) => item.key === key);
                if (!image) return;
                const rect = canvas.getBoundingClientRect();
                const imageHeightIn = getImageHeightIn(image);
                const xIn = Math.max(0, Math.min((event.clientX - rect.left) / canvas.clientWidth * state.pageWidthIn, state.pageWidthIn - image.width));
                const yIn = Math.max(0, Math.min((event.clientY - rect.top) / canvas.clientHeight * state.pageHeightIn, state.pageHeightIn - imageHeightIn));
                image.x = xIn;
                image.y = yIn;
                image.page = state.currentPage;
                state.active = image.key;
                renderImageList();
                updateAllOverlays();
            });

            document.getElementById("restablecer-btn").addEventListener("click", () => {
                restoreLastSavedPositions();
                state.currentPage = 1;
                goToPage(1);
                saveStatus.textContent = "Restablecido a la última posición guardada.";
            });
        }

        init().catch((err) => {
            console.error(err);
            alert("No se pudo cargar el preview PDF con pdf.js.");
        });
    })();
    