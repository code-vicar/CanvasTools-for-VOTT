import Konva from "konva";
import { Point2D } from "../../Core/Point2D";
import { RegionData } from "../../Core/RegionData";
import { TagsDescriptor } from "../../Core/TagsDescriptor";
import { DisabledMaskHostZIndex, EnabledMaskHostZIndex, KonvaContainerId } from "../../Core/Utils/constants";
import { ZoomManager } from "../../Core/ZoomManager";
import {
    IBrushSize,
    IDimension,
    IMask,
    IMaskManagerCallbacks,
    IRegionEdge,
    MaskSelectorMode,
} from "../../Interface/IMask";
import { SelectionMode } from "../../Interface/ISelectorSettings";
import { modelData } from "../../SegmentAnything/onnxModelAPI";
import { handleImageScale } from "../../SegmentAnything/scaleHelper";
import { onnxMaskToImage } from "../../SegmentAnything/maskUtils";
import { Tensor, InferenceSession } from "onnxruntime-web";
import NPYLoader from "npyjs";
import { modelInputProps } from "../../SegmentAnything/Interfaces";

export type LineJoin = "round" | "bevel" | "miter";
export type LineCap = "butt" | "round" | "square";

export class MasksManager {
    /**
     * Reference to the host konva stage element.
     */
    public konvaStage: Konva.Stage;

    /**
     * The current selected mode for mask. Brush or Eraser
     */
    public maskSelectionMode: MaskSelectorMode;

    /**
     * The brush and eraser size
     */
    public brushSize: IBrushSize;

    /**
     * Reference to the host konva div element.
     */
    public konvaContainerHostElement: HTMLDivElement;

    /**
     * Reference to the host div element.
     */
    private editorDiv: HTMLDivElement;

    /**
     * The current width of the editorDiv.
     */
    private currentEditorDivWidth: number;

    /**
     * The image mask holder
     */
    private maskImage?: HTMLImageElement;

    /**
     * The width of the source content.
     */
    private sourceWidth: number;

    /**
     * The height of the source content.
     */
    private sourceHeight: number;

    /**
     * Reference to the konva layer element that contains only the masks drawn
     */
    private canvasLayer: Konva.Layer;

    /**
     * The list of callbacks needed for mask manager
     */
    private callbacks: IMaskManagerCallbacks;

    /**
     * The list of tags used to draw masks
     */
    private tagsList: TagsDescriptor[];

    private onnxSession?: InferenceSession;

    private tensor?: Tensor;

    private samScale?: number;

    constructor(editorDiv: HTMLDivElement, konvaDivHostElement: HTMLDivElement, callbacks: IMaskManagerCallbacks) {
        this.callbacks = callbacks;
        this.tagsList = [];
        this.maskSelectionMode = SelectionMode.BRUSH;
        this.brushSize = {
            brush: 30,
            erase: 30,
        };
        this.editorDiv = editorDiv;
        this.konvaContainerHostElement = konvaDivHostElement;
        this.konvaContainerHostElement.style["z-index"] = DisabledMaskHostZIndex;
        this.buildUIElements();
    }

    /**
     * sets the height and width of source image
     * @param width - width of image
     * @param height - height of image
     */
    public setSourceDimensions(width: number, height: number): void {
        this.sourceWidth = width;
        this.sourceHeight = height;
        const { samScale } = handleImageScale({ naturalHeight: height, naturalWidth: width });
        this.samScale = samScale;
    }

    public async loadOnnxModel(modelUrl: string): Promise<void> {
        this.onnxSession = await InferenceSession.create(modelUrl);
    }

    public async loadSourceEmbeddings(tensorFileUrl: string): Promise<void> {
        const npyLoader = new NPYLoader();
        const npArray = await npyLoader.load(tensorFileUrl);
        this.tensor = new Tensor("float32", npArray.data, npArray.shape);
    }

    public async runOnnx(click: modelInputProps, tag: TagsDescriptor): Promise<void> {
        if (!this.onnxSession || !this.tensor) {
            return;
        }
        const feeds = modelData({
            clicks: [click],
            tensor: this.tensor,
            modelScale: {
                height: this.sourceHeight,
                width: this.sourceWidth,
                samScale: this.samScale,
            },
        });
        if (!feeds) {
            return;
        }
        // Run the SAM ONNX model with the feeds returned from modelData()
        const results = await this.onnxSession.run(feeds);
        const output = results[this.onnxSession.outputNames[0]];
        // The predicted mask returned from the ONNX model is an array which is 
        // rendered as an HTML image using onnxMaskToImage() from maskUtils.tsx.
        this.initializeImageMask();
        const [r, g, b] = tag.primary.srgbColor.to255();
        const SAMMaskImage = onnxMaskToImage(output.data, output.dims[2], output.dims[3], [r, g, b]);
        const currentDimensionsEditor = this.getCurrentDimension();
        SAMMaskImage.onload = (_e) => {
            const newKonvaImg = new Konva.Image({
                image: SAMMaskImage,
                height: currentDimensionsEditor.height,
                width: currentDimensionsEditor.width,
                perfectDrawEnabled: true,
            });
            this.canvasLayer.add(newKonvaImg);
        };
    }

    /**
     * enables and disables the masks manager with selected mask mode
     * @param enabled - indicates if mask selection is enabled
     * @param mode - optional. sets the mode of mask selection to either brush or eraser
     */
    public setSelection(enabled: boolean, mode?: MaskSelectorMode) {
        if (enabled) {
            this.maskSelectionMode = mode;
        }

        this.updateZIndex(enabled);
    }

    /**
     * sets the brush size
     * @param size - brush size
     */
    public setBrushSize(size: IBrushSize) {
        this.brushSize = size;
        this.setKonvaCursor();
    }

    /**
     * removes all masks and resets konva
     */
    public eraseAllMasks() {
        this.resetKonvaLayer();
    }

    /**
     * Resizes the manager to specified `width` and `height`.
     * @param width - The new manager width.
     * @param height - The new manager height.
     * @param initialRender - Optional param if true, konvaStage scale is set at 1
     */
    public resize(width: number, height: number, initialRender?: boolean) {
        let zoomScale = 1;
        if (this.konvaStage) {
            if (initialRender) {
                const zoom = ZoomManager.getInstance().getZoomData().currentZoomScale;
                this.konvaStage.scale({
                    x: 1 * zoom,
                    y: 1 * zoom,
                });
                this.konvaStage.width(width);
                this.konvaStage.height(height);
                this.rePositionStage();
                this.konvaStage.batchDraw();
                zoomScale = zoom;
            } else {
                const oldWidth = this.currentEditorDivWidth ?? this.konvaStage.width();
                const existingScale = this.konvaStage.scaleX();
                const toBeScale = width / oldWidth;
                const expectedScale = existingScale * toBeScale;
                this.konvaStage.scale({
                    x: expectedScale,
                    y: expectedScale,
                });
                this.reSizeStage(width, height);
                this.rePositionStage();
                this.konvaStage.batchDraw();
                zoomScale = expectedScale;
            }
            this.currentEditorDivWidth = width;
            this.setKonvaCursor(zoomScale);
        }
    }

    /**
     * hides or shows masks of particular tag name
     * @param isVisible sets the visibility to true or false
     * @param tagName name of the tag to update visibility
     */
    public updateMaskVisibility(isVisible: boolean, tagName: string): void {
        this.updateMaskVisibilityInternal(isVisible, tagName);
    }

    /**
     * converts all polygons to mask
     */
    public polygonsToMask(): void {
        this.convertRegionsToMask(this.canvasLayer);
    }

    /**
     * gets all the masks drawn on the canvas.
     */
    public getAllMasks(): IMask {
        // show all and then get all masks
        const tagsVisibility = this.tagsList.map((tag) => {
            return {
                isVisible: true,
                name: tag.primary.name,
            };
        });
        this.updateAllMaskVisibility(tagsVisibility);
        const currentDimensionsEditor = this.getCurrentDimension();
        const currentDimensions: IDimension = {
            width: this.sourceWidth,
            height: this.sourceHeight,
        };
        const width = this.konvaStage.width();
        const height = this.konvaStage.height();
        const scaleX = this.konvaStage.scaleX();
        const scaleY = this.konvaStage.scaleY();
        const x = this.konvaStage.x();
        const y = this.konvaStage.y();

        // The konva stage is scaled back to zoom = 1 before extracting image data out of canvas
        // post that, the konvaStage is scaled back to its original dimensions
        this.konvaStage
            .width(currentDimensionsEditor.width)
            .height(currentDimensionsEditor.height)
            .scaleX(1)
            .scaleY(1)
            .x(0)
            .y(0);
        let canvas: HTMLCanvasElement;
        canvas = this.canvasLayer.toCanvas({ pixelRatio: this.sourceWidth / currentDimensionsEditor.width });
        const ctx = canvas?.getContext("2d");
        const data: ImageData = ctx.getImageData(0, 0, currentDimensions.width, currentDimensions.height);
        this.konvaStage.width(width).height(height).scaleX(scaleX).scaleY(scaleY).x(x).y(y);
        const imgData = data.data;
        const newData: number[] = new Array(currentDimensions.width * currentDimensions.height);
        newData.fill(0);
        const tagsListExist = [];
        this.tagsList.forEach((tags: TagsDescriptor) => {
            const [r, g, b] = tags.primary.srgbColor.to255();
            const tagId = tags.primary.sequenceNumber;
            let tagExists = false;
            for (let i = 0; i <= data.data.length - 1; i = i + 4) {
                const ri = imgData[i];
                const gi = imgData[i + 1];
                const bi = imgData[i + 2];
                const t = 10;
                if (ri >= r - t && ri <= r + t && gi >= g - t && gi <= g + t && bi >= b - t && bi <= b + t) {
                    newData[i / 4] = tagId;
                    tagExists = true;
                }
            }
            tagsListExist.push(tagExists);
            ctx.clearRect(0, 0, currentDimensions.width, currentDimensions.height);
        });
        this.tagsList = this.tagsList.filter((tags, idx) => {
            return tagsListExist[idx];
        });
        return {
            imageData: newData,
            tags: this.tagsList,
        };
    }

    /**
     * Draws all the masks on the canvas
     * @param allMasks - all masks data to be drawn on canvas
     */
    public loadAllMasks(allMasks: IMask): void {
        this.initializeImageMask();
        this.loadMasksInternal(allMasks, this.canvasLayer);
    }

    /**
     * Removes antialiasing or smoothening from image data.
     * When drawing a shape on the canvas with smoothening on, the shape's edge has mixed pixel value
     * hence it looks curved. But when extracting image data out of canvas, we need each pixel to belong
     * to either of our tag colors. Hence if a pixel is on edge (its color value does not match any of the tag colors),
     * we look for the pixel value of its neighbouring 8 pixels to determine if we can assign the neighbours pixel value
     * to this pixel starting from topLeft pixel and going clockwise.
     */
    private unSmoothenImageData(
        edgeArray: number[],
        currentDimensions: IDimension,
        imgData: Uint8ClampedArray
    ): Uint8ClampedArray {
        for (let i = 0; i <= edgeArray.length - 1; i++) {
            if (edgeArray[i] === 1) {
                const topLeft = i - currentDimensions.width - 1 < 0 ? 0 : i - currentDimensions.width - 1;
                const top = i - currentDimensions.width < 0 ? 0 : i - currentDimensions.width;
                const topRight = i - currentDimensions.width + 1 < 0 ? 0 : i - currentDimensions.width + 1;
                const current = i;
                const previous = i - 1 < 0 ? 0 : i - 1;
                const next = i + 1 > edgeArray.length - 1 ? edgeArray.length - 1 : i + 1;
                const bottomLeft =
                    i + currentDimensions.width - 1 > edgeArray.length - 1
                        ? edgeArray.length - 1
                        : i + currentDimensions.width - 1;
                const bottom =
                    i + currentDimensions.width > edgeArray.length - 1
                        ? edgeArray.length - 1
                        : i + currentDimensions.width;
                const bottomRight =
                    i + currentDimensions.width + 1 > edgeArray.length - 1
                        ? edgeArray.length - 1
                        : i + currentDimensions.width + 1;

                const neighboringPixels = [];
                neighboringPixels.push(topLeft, top, topRight, previous, next, bottomLeft, bottom, bottomRight);
                const index = neighboringPixels.findIndex((j) => edgeArray[j] === 0);
                if (index >= 0) {
                    const pixel = neighboringPixels[index] * 4;
                    imgData[current * 4] = imgData[pixel];
                    imgData[current * 4 + 1] = imgData[pixel + 1];
                    imgData[current * 4 + 2] = imgData[pixel + 2];
                    imgData[current * 4 + 3] = imgData[pixel + 3];
                }
            }
        }

        return imgData;
    }

    /**
     * gets the pixels from the imageData that do not match any tag color. Hence they are edge pixels
     */
    private getEdgePixelArray(imageData: Uint8ClampedArray): number[] {
        const edgeArray: number[] = [];
        for (let i = 0; i <= imageData.length - 1; i = i + 4) {
            let edgePixel = true;
            edgeArray[i / 4] = 0;
            const r = imageData[i];
            const g = imageData[i + 1];
            const b = imageData[i + 2];
            if (r !== 0 && g !== 0 && b !== 0) {
                this.tagsList.forEach((tags: TagsDescriptor) => {
                    const [r1, g1, b1] = tags.primary.srgbColor.to255();
                    if (r === r1 && g === g1 && b === b1) {
                        edgePixel = false;
                    }
                });
                if (edgePixel) {
                    edgeArray[i / 4] = 1;
                }
            }
        }
        return edgeArray;
    }

    private initializeImageMask(): void {
        if (!this.maskImage) {
            this.maskImage = new Image();
        }
    }

    private updateMaskVisibilityInternal(isVisible: boolean, tagName: string): void {
        const shapes = this.canvasLayer.getChildren((node) => {
            return node.getAttr("name") === tagName;
        });
        shapes.forEach((shape) => {
            shape.visible(isVisible);
        });
    }

    private updateAllMaskVisibility(tags: Array<{ isVisible: boolean; name: string }>): void {
        tags.forEach((tag) => this.updateMaskVisibilityInternal(tag.isVisible, tag.name));
    }

    private convertRegionsToMask(layer: Konva.Layer) {
        const allRegions = this.callbacks.getAllRegions();
        allRegions.forEach((polygon: { id: string; tags: TagsDescriptor; regionData: RegionData }) => {
            const tags: TagsDescriptor = polygon.tags;
            this.addTagsDescriptor(tags);
            const points = polygon.regionData.points;
            const bezierPoints = polygon.regionData.bezierControls;
            const polygonPoints: IRegionEdge[] = [];
            points.forEach((point: Point2D, index: number) => {
                const nextIndex = index + 1 === points.length ? 0 : index + 1;
                const edge: IRegionEdge = {
                    start: {
                        x: point.x,
                        y: point.y,
                    },
                    end: {
                        x: points[nextIndex].x,
                        y: points[nextIndex].y,
                    },
                };
                if (bezierPoints[index] !== undefined) {
                    edge.controlPoint = bezierPoints.toJSON()[index];
                }
                polygonPoints.push(edge);
            });

            const bezierLineDestinationOut = new Konva.Shape({
                globalCompositeOperation: "destination-out",
                stroke: "black",
                fill: "black",
                strokeWidth: 1,
                perfectDrawEnabled: false,
                closed: true,
                listening: false,
                opacity: 1,
                name: "eraserLine",
                sceneFunc: (ctx, shape) => {
                    ctx.beginPath();
                    ctx.moveTo(polygonPoints[0].start.x, polygonPoints[0].start.y);
                    polygonPoints.forEach((edge: IRegionEdge) => {
                        if (edge.controlPoint) {
                            ctx.bezierCurveTo(
                                edge.controlPoint.c1.x,
                                edge.controlPoint.c1.y,
                                edge.controlPoint.c2.x,
                                edge.controlPoint.c2.y,
                                edge.end.x,
                                edge.end.y
                            );
                        } else {
                            ctx.lineTo(edge.end.x, edge.end.y);
                        }
                    });
                    ctx.closePath();
                    ctx.fillStrokeShape(shape);
                },
            });

            const bezierLineSourceOver = new Konva.Shape({
                globalCompositeOperation: "source-over",
                fill: tags.primary.color,
                stroke: tags.primary.color,
                fillEnabled: true,
                perfectDrawEnabled: false,
                strokeWidth: 1,
                closed: true,
                listening: false,
                opacity: 1,
                name: tags.primary.name,
                sceneFunc: (ctx, shape) => {
                    ctx.beginPath();
                    ctx.moveTo(polygonPoints[0].start.x, polygonPoints[0].start.y);
                    polygonPoints.forEach((edge: IRegionEdge) => {
                        if (edge.controlPoint) {
                            ctx.bezierCurveTo(
                                edge.controlPoint.c1.x,
                                edge.controlPoint.c1.y,
                                edge.controlPoint.c2.x,
                                edge.controlPoint.c2.y,
                                edge.end.x,
                                edge.end.y
                            );
                        } else {
                            ctx.lineTo(edge.end.x, edge.end.y);
                        }
                    });
                    ctx.closePath();
                    ctx.fillStrokeShape(shape);
                },
            });

            if (layer) {
                layer.add(bezierLineDestinationOut);
                layer.add(bezierLineSourceOver);
                layer.draw();
            }
        });
    }

    private loadMasksInternal(allMask: IMask, layer: Konva.Layer): void {
        const currentDimensionsEditor = this.getCurrentDimension();
        const currentDimensions: IDimension = {
            width: this.sourceWidth,
            height: this.sourceHeight,
        };

        if (
            currentDimensionsEditor &&
            !isNaN(currentDimensionsEditor.width) &&
            !isNaN(currentDimensionsEditor.height)
        ) {
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            canvas.width = currentDimensions.width;
            canvas.height = currentDimensions.height;

            const newdata = ctx.createImageData(currentDimensions.width, currentDimensions.height);
            const imageDataAll = newdata.data;
            const imgData = allMask.imageData;
            const tags: TagsDescriptor[] = allMask.tags;
            tags.forEach((tag: TagsDescriptor) => {
                const [r, g, b] = tag.primary.srgbColor.to255();
                this.addTagsDescriptor(tag);
                for (let i = 0; i <= imgData.length - 1; i++) {
                    if (imgData[i] === tag.primary.sequenceNumber) {
                        imageDataAll[i * 4] = r;
                        imageDataAll[i * 4 + 1] = g;
                        imageDataAll[i * 4 + 2] = b;
                        imageDataAll[i * 4 + 3] = 255;
                    }
                }
            });

            newdata.data.set(imageDataAll);
            ctx.putImageData(newdata, 0, 0);

            this.maskImage.src = canvas.toDataURL();
            this.maskImage.onload = (_e) => {
                const newKonvaImg = new Konva.Image({
                    image: this.maskImage,
                    height: currentDimensionsEditor.height,
                    width: currentDimensionsEditor.width,
                    perfectDrawEnabled: true,
                });
                layer.add(newKonvaImg);
            };
        }
    }

    private setKonvaCursor(zoomScale?: number): void {
        let size = this.maskSelectionMode === SelectionMode.BRUSH ? this.brushSize.brush : this.brushSize.erase;
        size = Math.floor(size * (zoomScale ?? 1));
        const base64 = this.base64EncodedMaskCursor(size);
        const cursor = ["url('", base64, "')", " ", Math.floor(size / 2) + 4, " ", Math.floor(size / 2) + 4, ",auto"];
        this.konvaStage.container().style.cursor = cursor.join("");
    }

    private base64EncodedMaskCursor(size): string {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        canvas.width = size + 8;
        canvas.height = size + 8;

        ctx.beginPath();
        ctx.arc(size / 2 + 4, size / 2 + 4, size / 2, 0, 2 * Math.PI, false);

        ctx.lineWidth = 2;
        ctx.strokeStyle = "white";
        ctx.stroke();

        return canvas.toDataURL();
    }

    private updateZIndex(enabled: boolean): void {
        this.konvaContainerHostElement.style["z-index"] = enabled ? EnabledMaskHostZIndex : DisabledMaskHostZIndex;
    }

    private getScaledPointerPosition(): { x: number; y: number } {
        const transform = this.konvaStage.getAbsoluteTransform().copy();
        transform.invert();
        const position = this.konvaStage.getPointerPosition();
        const scaledPosition = transform.point(position);
        return scaledPosition;
    }

    private addListeners(): void {
        let tag: TagsDescriptor;
        let isPaint = false;
        let currentLine: Konva.Line;
        let previousLine: Konva.Line;

        this.konvaStage.on("mousedown", (e: Konva.KonvaEventObject<MouseEvent>) => {
            const scaledPosition = this.getScaledPointerPosition();
            isPaint = true;
            tag = this.getTagsDescriptor();

            // delete any exisitng line/shape
            previousLine = new Konva.Line({
                globalCompositeOperation: "destination-out",
                strokeWidth:
                    this.maskSelectionMode === SelectionMode.BRUSH ? this.brushSize.brush : this.brushSize.erase,
                points: [scaledPosition.x, scaledPosition.y],
                name: "eraserLine",
                ...this.getLineShapeAttributes(),
            });

            this.canvasLayer.add(previousLine);

            // add the new line
            currentLine = new Konva.Line({
                stroke: tag.primary.color,
                strokeWidth:
                    this.maskSelectionMode === SelectionMode.BRUSH ? this.brushSize.brush : this.brushSize.erase,
                globalCompositeOperation:
                    this.maskSelectionMode === SelectionMode.BRUSH ? "source-over" : "destination-out",
                points: [scaledPosition.x, scaledPosition.y],
                name: tag.primary.name,
                ...this.getLineShapeAttributes(),
            });

            this.canvasLayer.add(currentLine);
        });

        this.konvaStage.on("mouseup", (_e: Konva.KonvaEventObject<MouseEvent>) => {
            isPaint = false;
            if (currentLine && currentLine.points().length < 3) {
                currentLine.destroy();
            }

            if (typeof this.callbacks.onMaskDrawingEnd === "function") {
                this.callbacks.onMaskDrawingEnd();
            }
        });

        this.konvaStage.on("mousemove", (_e: Konva.KonvaEventObject<MouseEvent>) => {
            if (!isPaint) {
                return;
            }

            const scaledPosition = this.getScaledPointerPosition();
            // delete
            const newPointsToRemove = previousLine.points().concat([scaledPosition.x, scaledPosition.y]);
            previousLine.points(newPointsToRemove);

            // add
            const newPoints = currentLine.points().concat([scaledPosition.x, scaledPosition.y]);
            currentLine.points(newPoints);
        });
    }

    private getCurrentDimension(): IDimension {
        const zoom = ZoomManager.getInstance().getZoomData().currentZoomScale;
        const style = getComputedStyle(this.editorDiv);
        return {
            width: parseInt(style.width, undefined) / zoom,
            height: parseInt(style.height, undefined) / zoom,
        };
    }

    private getLineShapeAttributes() {
        return {
            lineCap: "round" as LineCap,
            lineJoin: "round" as LineJoin,
            listening: false,
            tension: 0,
            perfectDrawEnabled: false,
            opacity: 1,
        };
    }

    private reSizeStage(width: number, height: number): void {
        const scrollContainer = document.getElementsByClassName("CanvasToolsContainer")[0];
        if (scrollContainer) {
            const style = getComputedStyle(scrollContainer);
            const maxWidth = parseFloat(style.width);
            const maxHeight = parseFloat(style.height);

            if (width <= maxWidth || height <= maxHeight) {
                this.konvaStage.width(width);
                this.konvaStage.height(height);
            }
            if (width > maxWidth && height > maxHeight) {
                this.konvaStage.width(maxWidth);
                this.konvaStage.height(maxHeight);
            }
        }
    }

    private rePositionStage() {
        const scrollContainer = document.getElementsByClassName("CanvasToolsContainer")[0];
        if (scrollContainer) {
            const dx = scrollContainer.scrollLeft;
            const dy = scrollContainer.scrollTop;
            this.konvaStage.container().style.transform = "translate(" + dx + "px, " + dy + "px)";
            this.konvaStage.x(-dx);
            this.konvaStage.y(-dy);
        }
    }

    private getTagsDescriptor(): TagsDescriptor {
        const tag = this.callbacks.onMaskDrawingBegin();
        const primaryTagName = tag?.primary?.name;
        if (!this.tagsList.find((tagObject: TagsDescriptor) => tagObject?.primary?.name === primaryTagName)) {
            this.tagsList.push(tag);
        }
        return tag;
    }

    private addTagsDescriptor(tag: TagsDescriptor): void {
        const primaryTagName = tag?.primary?.name;
        if (!this.tagsList.find((tagObject: TagsDescriptor) => tagObject?.primary?.name === primaryTagName)) {
            this.tagsList.push(tag);
        }
    }

    private resetKonvaLayer(): void {
        this.canvasLayer.destroyChildren();
        this.canvasLayer.destroy();
        this.canvasLayer = new Konva.Layer({});
        this.konvaStage.add(this.canvasLayer);
        this.tagsList = [];
    }

    private buildUIElements(): void {
        const currentDimensionsEditor = this.getCurrentDimension();
        const stage = new Konva.Stage({
            container: KonvaContainerId,
            width: currentDimensionsEditor.width,
            height: currentDimensionsEditor.height,
        });
        this.sourceHeight = currentDimensionsEditor.height;
        this.sourceWidth = currentDimensionsEditor.width;

        this.canvasLayer = new Konva.Layer({});
        stage.add(this.canvasLayer);

        this.konvaStage = stage;
        this.setKonvaCursor();
        this.addListeners();

        const scrollContainer = document.getElementsByClassName("CanvasToolsContainer")[0];
        scrollContainer?.addEventListener("scroll", () => this.rePositionStage());
    }
}
