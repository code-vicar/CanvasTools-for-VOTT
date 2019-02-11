import { LABColor, ILabColorPoint } from "./LABColor";
import { RGBColor } from "./RGBColor";

export interface ILABRGBGamutPoint {
    rgb: RGBColor;
    lab: LABColor;
}

/**
 * Palette settings.
 */
export interface IPaletteSettings {
    lightness: number;
    lightnessVariation: number;
    minGrayness: number;
    maxGrayness: number;
    granularity: number;
    abRange: number;
}

/**
 * The `Palette` class to generate a palette with specified settings
 * and extract a subset as color swatches.
 */
export class Palette {
    private gamutCluster: ILABRGBGamutPoint[];

    private generateClusterPromise: Promise<ILABRGBGamutPoint[]>;

    private settings: IPaletteSettings;

    /** Creates a new palette with provided settings */
    public constructor(settings: IPaletteSettings) {
        this.settings = {
            lightness: (settings.lightness === undefined) ?
                        0.65 : Math.max(0, Math.min(1, settings.lightness)),
            lightnessVariation: (settings.lightnessVariation === undefined) ?
                        0 : Math.max(0, Math.min(1, settings.lightnessVariation)),
            minGrayness: (settings.minGrayness === undefined) ?
                        0 : Math.max(0, Math.min(1, settings.minGrayness)),
            maxGrayness: (settings.maxGrayness === undefined) ?
                        2 : Math.max(0, Math.min(2, settings.maxGrayness)),
            granularity: (settings.granularity === undefined) ?
                        50 : Math.max(10, settings.granularity),
            abRange: (settings.abRange === undefined) ?
                        1.3 : Math.max(0, Math.min(2, settings.abRange)),
        };

        this.generateClusterPromise = this.generateGamutClusterAsync();
    }

    /**
     * Returns a promise with Gamut points resolved when all points are calculated.
     */
    public async gamut(): Promise<ILABRGBGamutPoint[]> {
        if (this.gamutCluster !== undefined && this.gamutCluster !== null) {
            return new Promise((resolve) => resolve(this.gamutCluster));
        } else {
            return this.generateClusterPromise.then((cluster) => {
                this.gamutCluster = cluster;
                return cluster;
            });
        }
    }

    /**
     * Generates a random set of swatches within the palette's gamut.
     * @param colorsCount - The number of colors to be generated.
     */
    public async swatches(colorsCount: number): Promise<ILABRGBGamutPoint[]> {
        return this.gamut().then((cluster) => {
            const swatches = new Array<ILABRGBGamutPoint>();
            const first = Math.round(Math.random() * cluster.length);
            swatches.push(cluster[first]);

            for (let i = 0; i < colorsCount - 1; i++) {
                swatches.push(this.findNextColor(swatches, cluster));
            }

            return swatches;
        });
    }

    /**
     * Expands provided set of swatches within the palette's gamut.
     * @param swatches - The original set of swatches.
     * @param colorsCount - The number of new colors to be generated.
     */
    public async more(swatches: ILABRGBGamutPoint[], colorsCount: number): Promise<ILABRGBGamutPoint[]> {
        if (swatches.length > 0) {
            return this.gamut().then((cluster) => {
                const newSwatches = new Array<ILABRGBGamutPoint>();
                const allSwatches = swatches.map((sw) => sw);
                for (let i = 0; i < colorsCount; i++) {
                    const swatch = this.findNextColor(allSwatches, cluster);
                    allSwatches.push(swatch);
                    newSwatches.push(swatch);
                }
                return newSwatches;
            });
        } else {
            return this.swatches(colorsCount);
        }
    }

    /**
     * Finds the next color to expand the swatches set within the palette's gamut.
     * Returns the point with maximum distance to all the colors in swatches.
     * @param swatches - The original set of swatches.
     * @param cluster - The cluster to look with-in.
     */
    private findNextColor(swatches: ILABRGBGamutPoint[], cluster: ILABRGBGamutPoint[]): ILABRGBGamutPoint {
        let candidate: ILABRGBGamutPoint = cluster[0];
        let maxDistanceSQ: number = 0;

        cluster.forEach((colorPoint) => {
            const distances = swatches.map((swatchPoint) => {
                return colorPoint.lab.distanceTo(swatchPoint.lab);
            });
            const minDistanceSQ = Math.min(...distances);
            if (minDistanceSQ > maxDistanceSQ) {
                candidate = colorPoint;
                maxDistanceSQ = minDistanceSQ;
            }
        });

        return candidate;
    }

    /**
     * Wraps the `generateGamutCluster` method into a Promise.
     */
    private generateGamutClusterAsync(): Promise<ILABRGBGamutPoint[]> {
        const promise = new Promise<ILABRGBGamutPoint[]>((resolve) => {
            this.gamutCluster = this.generateGamutCluster();
            resolve(this.gamutCluster);
        });
        return promise;
    }

    /**
     * Generates a gamut cluster of paired colors in CIELAB (LAB) and RGB,
     * filtered by color points valid in RGB space and grayness constrains
     * (withing the range of [`minGrainess`, `maxGrayness`]).
     *
     * This method augments the `generatePointsCluster` method with lightness settings,
     * putting lightness equal to a random value within the range
     * [`lightness` - `lightnessVariation`/2, `lightness` + `lightnessVariation`/2].
     */
    private generateGamutCluster(): ILABRGBGamutPoint[] {
        let cluster = this.generatePointsCluster(this.settings.granularity);
        cluster = cluster.filter((p) => {
            const d = this.distanceToGray(p);
            return d >= this.settings.minGrayness && d <= this.settings.maxGrayness;
        });

        const colorSpace = new Array<ILABRGBGamutPoint>();

        cluster.forEach((p) => {
            let lightness = this.settings.lightness;
            if (this.settings.lightnessVariation > 0) {
                lightness += this.settings.lightnessVariation * (Math.random() - 0.5);
                lightness = Math.max(0, Math.min(1, lightness));
            }

            const labcolor = new LABColor(lightness, p.a, p.b);
            const rgbcolor = labcolor.toRGB();

            if (rgbcolor.isValidRGB()) {
                colorSpace.push({
                    rgb: rgbcolor,
                    lab: labcolor,
                });
            }
        });
        return colorSpace;
    }

    /**
     * Calculate distance from color point to a zero-point (`a = b = 0`).
     * @param p - Origin point.
     */
    private distanceToGray(p: ILabColorPoint) {
        return Math.sqrt(p.a * p.a + p.b * p.b);
    }

    /**
     * Generate a grid of color points in AB-subspace, centered at `a = b = 0` and
     * the grid size [-`abRage`, +`abRange`] in each dimension.
     * @param granularity - Number of grid steps in each dimension.
     */
    private generatePointsCluster(granularity: number): ILabColorPoint[] {
        granularity = Math.round(granularity);
        const cluster = new Array<ILabColorPoint>(granularity * granularity);

        const range = this.settings.abRange;

        for (let i = 0; i < granularity; i++) {
            for (let j = 0; j < granularity; j++) {
                cluster[i * granularity + j] = {
                    a: range * 2 * i / (granularity - 1) - range,
                    b: range * 2 * j / (granularity - 1) - range,
                };
            }
        }

        return cluster;
    }
}
