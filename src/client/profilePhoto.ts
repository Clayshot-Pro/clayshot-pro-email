export type CropSource = {
  url: string;
  image: HTMLImageElement;
  width: number;
  height: number;
};

export type Point = {
  x: number;
  y: number;
};

type CropMetrics = {
  scale: number;
  displayedWidth: number;
  displayedHeight: number;
  maxX: number;
  maxY: number;
};

const CROP_SIZE = 260;
export const MAX_ZOOM = 3;
const OUTPUT_SIZE = 512;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function cropMetrics(source: CropSource, zoom: number): CropMetrics {
  const baseScale = Math.max(CROP_SIZE / source.width, CROP_SIZE / source.height);
  const scale = baseScale * zoom;
  const displayedWidth = source.width * scale;
  const displayedHeight = source.height * scale;
  return {
    scale,
    displayedWidth,
    displayedHeight,
    maxX: Math.max(0, (displayedWidth - CROP_SIZE) / 2),
    maxY: Math.max(0, (displayedHeight - CROP_SIZE) / 2),
  };
}

export async function loadCropSource(file: File): Promise<CropSource> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("That image could not be opened"));
      image.src = url;
    });

    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error("That image could not be opened");
    }

    return {
      url,
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function renderCroppedPhoto(
  source: CropSource,
  zoom: number,
  offset: Point,
): Promise<Blob> {
  const metrics = cropMetrics(source, zoom);
  const boundedX = clamp(offset.x, -metrics.maxX, metrics.maxX);
  const boundedY = clamp(offset.y, -metrics.maxY, metrics.maxY);
  const left = (CROP_SIZE - metrics.displayedWidth) / 2 + boundedX;
  const top = (CROP_SIZE - metrics.displayedHeight) / 2 + boundedY;
  const sourceX = Math.max(0, -left / metrics.scale);
  const sourceY = Math.max(0, -top / metrics.scale);
  const sourceWidth = Math.min(source.width - sourceX, CROP_SIZE / metrics.scale);
  const sourceHeight = Math.min(source.height - sourceY, CROP_SIZE / metrics.scale);

  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Photo processing is unavailable");

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    source.image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    OUTPUT_SIZE,
    OUTPUT_SIZE,
  );

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );
  if (!blob) throw new Error("Photo processing failed");
  return blob;
}
