export declare function encode(lat: number, lng: number, length?: number): string;
export interface Bounds {
    south: number;
    west: number;
    north: number;
    east: number;
}
export declare function bounds(hash: string): Bounds;
/** Every cell of [length] that overlaps the box. */
export declare function cellsIn(box: Bounds, length?: number): string[];
/** World pixel coordinates in Web Mercator at [zoom], 256-pixel tiles. */
export declare function toPixel(lat: number, lng: number, zoom: number): {
    x: number;
    y: number;
};
export declare function fromPixel(x: number, y: number, zoom: number): {
    lat: number;
    lng: number;
};
