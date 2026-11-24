import { ChangeEvent, CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { BlobReader, BlobWriter, ZipReader } from "@zip.js/zip.js";

import { flushSync } from "react-dom";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  PhotoAdjustDialog,
  PhotoCrop,
  clampNumber,
  cleanCrop,
  cleanZoom,
  croppedRatio,
  photoAdjustStyle,
} from "./PhotoAdjust";

function CoverText({ label, text, onEdit }: {
  label: string;
  text: string;
  onEdit: () => void;
}) {
  return (
    <>
      <button className="cover-text-trigger" type="button" aria-label={label} onClick={onEdit}>{text}</button>
      <span className="cover-text-print">{text}</span>
    </>
  );
}

type Photo = {
  id: string;
  name: string;
  url: string;
  date: Date;
  signature?: string;
  width?: number;
  height?: number;
  brightness?: "bright" | "soft" | "dark";
  latitude?: number;
  longitude?: number;
  detectedPlace?: string;
  // For finding duplicates: a 64-bit visual fingerprint, a sharpness score and the average light level.
  hash?: string;
  sharpness?: number;
  exposure?: number;
  // Size inside its cell: below 1 the photo shrinks, above 1 it zooms in (edges are cut). Proportions never change.
  zoom?: number;
  crop?: PhotoCrop;
};

type CoverImage = Pick<Photo, "id" | "name" | "url">;
type PageContent = {
  title?: string;
  date?: string;
  text?: string;
};
type CaptionMode = "basic" | "ai";
type CaptionSource = "auto" | "manual";
type AlbumFont = "classic" | "rounded" | "elegant" | "playful";
type PageDecoration = "none" | "sparkles" | "hearts" | "flowers" | "sun" | "anchor" | "camera" | "plane" | "location" | "waves";
type SinglePhotoMode = "page" | "spread";
type PageLayout = {
  photosPerPage?: number;
  singlePhotoMode?: SinglePhotoMode;
};
type AlbumPage = {
  pagePhotos: Photo[];
  pageIndex: number;
  pageKey: string;
  startIndex: number;
  capacity: number;
  singlePhotoMode: SinglePhotoMode;
};
type StoredPhoto = Omit<Photo, "url" | "date"> & {
  blob: Blob;
  date: string;
};
type StoredCoverImage = Omit<CoverImage, "url"> & {
  blob: Blob;
};
type PhotoLibrary = {
  id: string;
  name: string;
  createdAt: string;
  photos: StoredPhoto[];
};
type StoredAlbum = {
  id: "current";
  savedAt: string;
  photos: StoredPhoto[];
  photosPerPage: number;
  title: string;
  subtitle: string;
  note: string;
  coverDateText: string;
  coverPhotoId: string;
  customCover: StoredCoverImage | null;
  showPhotoDates: boolean;
  dateDisplayPreferenceVersion?: 1;
  pageContent: Record<string, PageContent>;
  pageLayouts?: Record<string, PageLayout>;
  photoCaptions: Record<string, string>;
  captionSources?: Record<string, CaptionSource>;
  captionMode: CaptionMode;
  placeHint: string;
  albumFont: AlbumFont;
  pageDecorations: Record<string, PageDecoration>;
  showRoutePage?: boolean;
  routeTitle?: string;
  routePlaces?: string[];
};
type ExportedPhoto = Omit<StoredPhoto, "blob"> & {
  dataUrl: string;
};
type ExportedCoverImage = Omit<StoredCoverImage, "blob"> & {
  dataUrl: string;
};
type ExportedAlbum = Omit<StoredAlbum, "photos" | "customCover"> & {
  exportVersion: 1;
  exportedAt: string;
  photos: ExportedPhoto[];
  customCover: ExportedCoverImage | null;
};
type AlbumSnapshot = {
  photos: Photo[];
  photosPerPage: number;
  title: string;
  subtitle: string;
  note: string;
  coverDateText: string;
  coverPhotoId: string;
  customCover: CoverImage | null;
  showPhotoDates: boolean;
  pageContent: Record<string, PageContent>;
  pageLayouts: Record<string, PageLayout>;
  photoCaptions: Record<string, string>;
  captionSources: Record<string, CaptionSource>;
  captionMode: CaptionMode;
  placeHint: string;
  albumFont: AlbumFont;
  pageDecorations: Record<string, PageDecoration>;
  showRoutePage: boolean;
  routeTitle: string;
  routePlaces: string[];
};
type DropTarget = { type: "photo"; id: string } | { type: "empty"; index: number } | null;
type PrintablePage =
  | { type: "cover" }
  | { type: "coverBack" }
  | { type: "route" }
  | { type: "photo"; albumPage: AlbumPage }
  | { type: "photoSpreadHalf"; albumPage: AlbumPage; side: "start" | "end" }
  | { type: "empty" };

type PhotoOrientation = "portrait" | "landscape" | "square";

// On iPhone/iPad, asking only for "image/*" makes iOS hand over ready JPEGs instead of HEIC,
// so the browser does not have to convert them (that conversion can run Safari out of memory).
const IS_IOS = typeof navigator !== "undefined" && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
);
const PHOTO_ACCEPT = IS_IOS ? "image/*" : "image/*,.heic,.heif";

const IMAGE_FILE_PATTERN = /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i;

function isSupportedImageFile(file: File) {
  return file.type.startsWith("image/") || IMAGE_FILE_PATTERN.test(file.name);
}

function imageMimeType(filename: string) {
  const extension = filename.toLowerCase().split(".").pop();
  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
  };
  return mimeTypes[extension || ""] || "application/octet-stream";
}

async function extractImagesFromZip(zipFile: File) {
  const reader = new ZipReader(new BlobReader(zipFile));
  const extractedFiles: File[] = [];

  try {
    const entries = await reader.getEntries();
    for (const entry of entries) {
      if (entry.directory || !IMAGE_FILE_PATTERN.test(entry.filename) || entry.filename.includes("__MACOSX/")) {
        continue;
      }

      const blob = await entry.getData(new BlobWriter(imageMimeType(entry.filename)));
      const filename = entry.filename.split("/").pop() || entry.filename;
      extractedFiles.push(new File([blob], filename, {
        type: imageMimeType(filename),
        lastModified: entry.lastModDate?.getTime() || zipFile.lastModified || Date.now(),
      }));
    }
  } finally {
    await reader.close();
  }

  return extractedFiles;
}

const ALBUM_DB_NAME = "tamar-photo-album";
const ALBUM_DB_VERSION = 2;
const ALBUM_STORE_NAME = "albums";
const PHOTO_LIBRARY_STORE_NAME = "photo-libraries";
const CURRENT_ALBUM_ID = "current";
const DEFAULT_ALBUM_FONT: AlbumFont = "classic";
const PHOTO_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6];
const DEFAULT_ROUTE_PLACES = [
  "נקודת יציאה",
  "יעד ראשון",
  "יעד שני",
];
const DECORATION_LABELS: Record<PageDecoration, string> = {
  none: "",
  sparkles: "✦",
  hearts: "♡",
  flowers: "❦",
  sun: "☼",
  anchor: "⚓",
  camera: "◉",
  plane: "✈",
  location: "⌖",
  waves: "≈",
};

type Heic2Any = (options: {
  blob: Blob;
  toType?: string;
  quality?: number;
}) => Promise<Blob | Blob[]>;

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("he-IL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function getPageLayout(
  pageLayouts: Record<string, PageLayout>,
  pageKey: string,
  defaultPhotosPerPage: number,
) {
  const layout = pageLayouts[pageKey] || {};
  const capacity = PHOTO_COUNT_OPTIONS.includes(layout.photosPerPage || 0)
    ? layout.photosPerPage as number
    : defaultPhotosPerPage;

  return {
    capacity,
    singlePhotoMode: layout.singlePhotoMode || "page" as SinglePhotoMode,
  };
}

function paginatePhotos(
  photosToPaginate: Photo[],
  defaultPhotosPerPage: number,
  pageLayouts: Record<string, PageLayout>,
) {
  const albumPages: AlbumPage[] = [];
  let photoIndex = 0;
  let pageIndex = 0;

  while (photoIndex < photosToPaginate.length) {
    const pageKey = photosToPaginate[photoIndex].id;
    const layout = getPageLayout(pageLayouts, pageKey, defaultPhotosPerPage);
    const capacity = Math.max(1, layout.capacity);
    const pagePhotos = photosToPaginate.slice(photoIndex, photoIndex + capacity);

    albumPages.push({
      pagePhotos,
      pageIndex,
      pageKey,
      startIndex: photoIndex,
      capacity,
      singlePhotoMode: layout.singlePhotoMode,
    });

    photoIndex += pagePhotos.length;
    pageIndex += 1;
  }

  return albumPages;
}

function sortPhotosByDate(photosToSort: Photo[]) {
  return [...photosToSort].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function getPhotoOrientation(photo: Photo): PhotoOrientation {
  if (!photo.width || !photo.height) return "square";
  const ratio = photo.width / photo.height;
  if (ratio > 1.08) return "landscape";
  if (ratio < 0.92) return "portrait";
  return "square";
}

function getPageOrientationClass(pagePhotos: Photo[]) {
  const orientations = pagePhotos.map(getPhotoOrientation);
  if (orientations.length && orientations.every((orientation) => orientation === "portrait")) {
    return "layout-all-portrait";
  }
  if (orientations.length && orientations.every((orientation) => orientation === "landscape")) {
    return "layout-all-landscape";
  }
  return "layout-mixed";
}

function photoRatio(photo: Photo) {
  const ratio = croppedRatio(photo);
  return Math.min(3.5, Math.max(0.3, ratio));
}

type LayoutLine = { grow: number; items: Array<{ index: number; grow: number }> };
type PageLayoutPlan = { mode: "rows" | "cols"; lines: LayoutLine[] };

// Geometric mean of the photo areas: rewards using the page well, but punishes one huge photo next to tiny ones.
function balancedScore(areas: number[]) {
  if (!areas.length || areas.some((area) => area <= 0)) return 0;
  return Math.exp(areas.reduce((sum, area) => sum + Math.log(area), 0) / areas.length);
}

// Every way to split n photos, in order, into consecutive groups (n ≤ 6 → at most 32 options).
function orderedGroupings(count: number): number[][] {
  if (count <= 0) return [[]];
  const results: number[][] = [];
  for (let mask = 0; mask < 1 << (count - 1); mask += 1) {
    const sizes: number[] = [];
    let size = 1;
    for (let index = 0; index < count - 1; index += 1) {
      if (mask & (1 << index)) {
        sizes.push(size);
        size = 1;
      } else {
        size += 1;
      }
    }
    sizes.push(size);
    results.push(sizes);
  }
  return results;
}

// Chooses rows or columns so that each cell has the same shape as its photo
// (portrait cells for portrait photos, wide cells for landscape ones) and the photos cover as much of the page as possible.
function planPageLayout(ratios: number[], slotCount: number): PageLayoutPlan {
  const width = 1;
  const height = 1.2; // photo area of an A4 page, below the page title
  const gap = 0.03;
  const caption = slotCount <= 2 ? 0.12 : slotCount <= 4 ? 0.1 : 0.09;
  const fallback: PageLayoutPlan = {
    mode: "rows",
    lines: [{ grow: 1, items: ratios.map((ratio, index) => ({ index, grow: ratio })) }],
  };
  if (!ratios.length) return fallback;

  let best: { score: number; plan: PageLayoutPlan } | null = null;
  for (const sizes of orderedGroupings(ratios.length)) {
    const groups: number[][] = [];
    let cursor = 0;
    sizes.forEach((size) => {
      groups.push(Array.from({ length: size }, (_, offset) => cursor + offset));
      cursor += size;
    });

    // Rows: photos in a row share one height.
    const rowHeights = groups.map((group) => (
      (width - gap * (group.length - 1)) / group.reduce((sum, index) => sum + ratios[index], 0)
    ));
    const rowSpace = height - groups.length * caption - gap * (groups.length - 1);
    if (rowSpace > 0) {
      const scale = Math.min(1, rowSpace / rowHeights.reduce((sum, value) => sum + value, 0));
      const area = balancedScore(groups.flatMap((group, line) => (
        group.map((index) => ratios[index] * (scale * rowHeights[line]) ** 2)
      )));
      if (!best || area > best.score) {
        best = {
          score: area,
          plan: {
            mode: "rows",
            lines: groups.map((group, line) => ({
              grow: scale * rowHeights[line] + caption,
              items: group.map((index) => ({ index, grow: ratios[index] })),
            })),
          },
        };
      }
    }

    // Columns: photos in a column share one width (each photo has its own caption underneath).
    if (groups.length > 1) {
      const columnWidths = groups.map((group) => (
        (height - group.length * caption - gap * (group.length - 1)) /
        group.reduce((sum, index) => sum + 1 / ratios[index], 0)
      ));
      if (columnWidths.every((value) => value > 0)) {
        const scale = Math.min(1, (width - gap * (groups.length - 1)) / columnWidths.reduce((sum, value) => sum + value, 0));
        const area = 0.97 * balancedScore(groups.flatMap((group, line) => (
          group.map((index) => (scale * columnWidths[line]) ** 2 / ratios[index])
        )));
        if (!best || area > best.score) {
          best = {
            score: area,
            plan: {
              mode: "cols",
              lines: groups.map((group, line) => ({
                grow: scale * columnWidths[line],
                items: group.map((index) => ({ index, grow: (scale * columnWidths[line]) / ratios[index] + caption })),
              })),
            },
          };
        }
      }
    }
  }

  return best?.plan || fallback;
}

function isHeicFile(file: File) {
  return (
    /image\/hei[cf]/i.test(file.type) ||
    /\.(heic|heif)$/i.test(file.name)
  );
}

function fileSignature(file: File) {
  return `${file.name.toLowerCase()}::${file.size}::${file.lastModified || 0}`;
}

function fileDateSignature(file: File) {
  return `${file.name.toLowerCase()}::${file.lastModified || 0}`;
}

async function fileToDisplayBlob(file: File) {
  if (!isHeicFile(file)) return file;

  const heic2anyModule = await import("heic2any");
  const heic2any = heic2anyModule.default as Heic2Any;
  const converted = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.9,
  });

  return Array.isArray(converted) ? converted[0] : converted;
}

const luma = (pixels: Uint8ClampedArray, offset: number) => (
  pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114
);

// Visual fingerprint (difference hash) and sharpness (variance of the Laplacian) of an image.
function analyzeImage(image: HTMLImageElement): Pick<Photo, "hash" | "sharpness"> {
  const hashCanvas = document.createElement("canvas");
  hashCanvas.width = 9;
  hashCanvas.height = 8;
  const hashContext = hashCanvas.getContext("2d", { willReadFrequently: true });
  if (!hashContext) return {};
  hashContext.drawImage(image, 0, 0, 9, 8);
  const hashPixels = hashContext.getImageData(0, 0, 9, 8).data;
  let hash = "";
  for (let y = 0; y < 8; y += 1) {
    let nibble = 0;
    for (let x = 0; x < 8; x += 1) {
      const left = luma(hashPixels, (y * 9 + x) * 4);
      const right = luma(hashPixels, (y * 9 + x + 1) * 4);
      nibble = (nibble << 1) | (left < right ? 1 : 0);
      if (x % 4 === 3) {
        hash += nibble.toString(16);
        nibble = 0;
      }
    }
  }

  const maxSide = 256;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(8, Math.round(image.naturalWidth * scale));
  const height = Math.max(8, Math.round(image.naturalHeight * scale));
  const sharpCanvas = document.createElement("canvas");
  sharpCanvas.width = width;
  sharpCanvas.height = height;
  const sharpContext = sharpCanvas.getContext("2d", { willReadFrequently: true });
  if (!sharpContext) return { hash };
  sharpContext.drawImage(image, 0, 0, width, height);
  const pixels = sharpContext.getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  for (let index = 0; index < gray.length; index += 1) gray[index] = luma(pixels, index * 4);
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const center = y * width + x;
      const value = gray[center - 1] + gray[center + 1] + gray[center - width] + gray[center + width] - 4 * gray[center];
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  const mean = count ? sum / count : 0;
  return { hash, sharpness: count ? Math.round(sumSquares / count - mean * mean) : 0 };
}

function hashDistance(first: string, second: string) {
  let distance = 0;
  for (let index = 0; index < 16; index += 1) {
    let bits = parseInt(first[index] || "0", 16) ^ parseInt(second[index] || "0", 16);
    while (bits) {
      distance += bits & 1;
      bits >>= 1;
    }
  }
  return distance;
}

// Higher is better: sharp first, then resolution, then a well-exposed (not too dark or bright) picture.
function photoQuality(photo: Photo) {
  const sharpness = Math.log1p(photo.sharpness || 0);
  const pixels = Math.log((photo.width || 1) * (photo.height || 1));
  const exposurePenalty = typeof photo.exposure === "number" ? Math.abs(photo.exposure - 125) / 125 : 0;
  return sharpness * 2 + pixels * 0.3 - exposurePenalty * 1.5;
}

// Groups photos that are the same picture or near-identical shots (burst, retakes), in album order.
function findSimilarGroups(photos: Photo[]) {
  const parent = photos.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const isCopyOf = (a: Photo, b: Photo) => a.id.startsWith(`${b.id}-copy-`) || b.id.startsWith(`${a.id}-copy-`);

  for (let first = 0; first < photos.length; first += 1) {
    for (let second = first + 1; second < photos.length; second += 1) {
      const a = photos[first];
      const b = photos[second];
      if (isCopyOf(a, b)) continue;
      let similar = Boolean(a.signature && a.signature === b.signature);
      if (!similar && a.hash?.length === 16 && b.hash?.length === 16) {
        const distance = hashDistance(a.hash, b.hash);
        const minutesApart = Math.abs(a.date.getTime() - b.date.getTime()) / 60000;
        similar = distance <= 4 || (distance <= 10 && minutesApart <= 15);
      }
      if (similar) parent[find(second)] = find(first);
    }
  }

  const groups = new Map<number, Photo[]>();
  photos.forEach((photo, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) || []), photo]);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

function bestPhotoOf(group: Photo[]) {
  return group.reduce((best, photo) => (photoQuality(photo) > photoQuality(best) ? photo : best), group[0]);
}

function readImageDetails(url: string) {
  return new Promise<Pick<Photo, "width" | "height" | "brightness" | "hash" | "sharpness" | "exposure">>((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 32;
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });

      if (!context) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
        return;
      }

      context.drawImage(image, 0, 0, size, size);
      const pixels = context.getImageData(0, 0, size, size).data;
      let total = 0;

      for (let index = 0; index < pixels.length; index += 4) {
        total += (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      }

      const average = total / (pixels.length / 4);
      let analysis: Pick<Photo, "hash" | "sharpness"> = {};
      try {
        analysis = analyzeImage(image);
      } catch {
        // Analysis only helps find duplicates; the photo is fine without it.
      }
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
        brightness: average > 178 ? "bright" : average < 92 ? "dark" : "soft",
        exposure: Math.round(average),
        ...analysis,
      });
    };
    image.onerror = () => resolve({});
    image.src = url;
  });
}

type PhotoMetadata = {
  takenAt?: Date;
  latitude?: number;
  longitude?: number;
};

type ExifrParse = (input: Blob, options: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;

// Reads when the photo was actually taken (EXIF), plus its GPS position.
// file.lastModified is only the download/export time, which is wrong for iCloud, ZIP and converted HEIC files.
// Never let a slow or stuck metadata read hold up adding the photo.
function readPhotoMetadata(blob: Blob): Promise<PhotoMetadata> {
  return Promise.race([
    readPhotoMetadataNow(blob),
    new Promise<PhotoMetadata>((resolve) => setTimeout(() => resolve({}), 6000)),
  ]);
}

async function readPhotoMetadataNow(blob: Blob): Promise<PhotoMetadata> {
  try {
    const exifrModule = await import("exifr");
    const imported = exifrModule as unknown as { parse?: ExifrParse; default?: { parse?: ExifrParse } };
    const parse = imported.parse || imported.default?.parse;
    if (!parse) return {};
    const data = await parse(blob, { tiff: true, exif: true, gps: true, xmp: false, icc: false, iptc: false });
    if (!data) return {};

    const metadata: PhotoMetadata = {};
    const taken = data.DateTimeOriginal || data.CreateDate || data.DateTimeDigitized || data.ModifyDate;
    if (taken instanceof Date && !Number.isNaN(taken.getTime()) && taken.getFullYear() > 1990) {
      metadata.takenAt = taken;
    }
    if (
      typeof data.latitude === "number" &&
      Number.isFinite(data.latitude) &&
      typeof data.longitude === "number" &&
      Number.isFinite(data.longitude)
    ) {
      metadata.latitude = data.latitude;
      metadata.longitude = data.longitude;
    }
    return metadata;
  } catch {
    // Many shared or edited images no longer contain EXIF metadata.
    return {};
  }
}

function photoDateFrom(file: File, metadata: PhotoMetadata) {
  return metadata.takenAt || new Date(file.lastModified || Date.now());
}

function gpsFrom(metadata: PhotoMetadata) {
  return typeof metadata.latitude === "number" && typeof metadata.longitude === "number"
    ? { latitude: metadata.latitude, longitude: metadata.longitude }
    : {};
}

async function reverseGeocode(latitude: number, longitude: number) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  url.searchParams.set("zoom", "16");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "he,en");

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("שירות שמות המקומות אינו זמין כרגע.");

  const data = await response.json() as {
    name?: string;
    display_name?: string;
    address?: Record<string, string | undefined>;
  };
  const address = data.address || {};
  const landmark = address.tourism || address.attraction || address.historic || address.amenity;
  const locality = address.city || address.town || address.village || address.municipality || address.county;
  const parts = [landmark || data.name, locality, address.country]
    .map((part) => part?.trim())
    .filter((part, index, all): part is string => Boolean(part) && all.indexOf(part) === index);
  return parts.join(", ") || data.display_name?.split(",").slice(0, 3).join(",").trim() || "";
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Page settings (title, text, layout, decoration) belong to the page's first photo,
// so they follow that photo when other photos are added or removed.
// Older saves keyed them by page number; convert those once on load.
function migratePageKeyedMap<T>(map: Record<string, T> | undefined, pageStartIds: string[]) {
  const result: Record<string, T> = {};
  Object.entries(map || {}).forEach(([key, value]) => {
    if (/^\d+$/.test(key)) {
      const photoId = pageStartIds[Number(key)];
      if (photoId) result[photoId] = value;
    } else {
      result[key] = value;
    }
  });
  return result;
}

function numericPageStartIds(
  photoIds: string[],
  defaultPhotosPerPage: number,
  layouts: Record<string, PageLayout> | undefined,
) {
  const starts: string[] = [];
  let photoIndex = 0;
  let pageIndex = 0;
  while (photoIndex < photoIds.length) {
    const layout = layouts?.[String(pageIndex)] || {};
    const capacity = PHOTO_COUNT_OPTIONS.includes(layout.photosPerPage || 0)
      ? layout.photosPerPage as number
      : defaultPhotosPerPage;
    starts.push(photoIds[photoIndex]);
    photoIndex += Math.max(1, capacity);
    pageIndex += 1;
  }
  return starts;
}

function openAlbumDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(ALBUM_DB_NAME, ALBUM_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ALBUM_STORE_NAME)) {
        database.createObjectStore(ALBUM_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PHOTO_LIBRARY_STORE_NAME)) {
        database.createObjectStore(PHOTO_LIBRARY_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("לא ניתן לפתוח שמירה בדפדפן."));
  });
}

async function readPhotoLibraries() {
  const database = await openAlbumDatabase();

  return new Promise<PhotoLibrary[]>((resolve, reject) => {
    const transaction = database.transaction(PHOTO_LIBRARY_STORE_NAME, "readonly");
    const request = transaction.objectStore(PHOTO_LIBRARY_STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as PhotoLibrary[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(request.error || new Error("לא ניתן לקרוא את מאגר התמונות."));
    transaction.oncomplete = () => database.close();
  });
}

async function writePhotoLibrary(library: PhotoLibrary) {
  const database = await openAlbumDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PHOTO_LIBRARY_STORE_NAME, "readwrite");
    transaction.objectStore(PHOTO_LIBRARY_STORE_NAME).put(library);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("לא ניתן לשמור את אלבום התמונות במאגר."));
    };
  });
}

async function removePhotoLibrary(id: string) {
  const database = await openAlbumDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(PHOTO_LIBRARY_STORE_NAME, "readwrite");
    transaction.objectStore(PHOTO_LIBRARY_STORE_NAME).delete(id);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("לא ניתן למחוק את האלבום מהמאגר."));
    };
  });
}

async function readSavedAlbum() {
  const database = await openAlbumDatabase();

  return new Promise<StoredAlbum | undefined>((resolve, reject) => {
    const transaction = database.transaction(ALBUM_STORE_NAME, "readonly");
    const request = transaction.objectStore(ALBUM_STORE_NAME).get(CURRENT_ALBUM_ID);

    request.onsuccess = () => resolve(request.result as StoredAlbum | undefined);
    request.onerror = () => reject(request.error || new Error("לא ניתן לקרוא את האלבום השמור."));
    transaction.oncomplete = () => database.close();
  });
}

async function writeSavedAlbum(album: StoredAlbum) {
  const database = await openAlbumDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(ALBUM_STORE_NAME, "readwrite");
    transaction.objectStore(ALBUM_STORE_NAME).put(album);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("לא ניתן לשמור את האלבום בדפדפן."));
    };
  });
}

async function removeSavedAlbum() {
  const database = await openAlbumDatabase();

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(ALBUM_STORE_NAME, "readwrite");
    transaction.objectStore(ALBUM_STORE_NAME).delete(CURRENT_ALBUM_ID);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("לא ניתן למחוק את האלבום השמור."));
    };
  });
}

async function urlToBlob(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("לא ניתן להכין את אחת התמונות לשמירה.");
  return response.blob();
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("לא ניתן להכין קובץ אלבום."));
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error("קובץ האלבום מכיל תמונה שלא ניתן לקרוא.");
  return response.blob();
}

function suggestedCaption(photo: Photo) {
  return photo.detectedPlace ? `${photo.detectedPlace} · ${formatDate(photo.date)}` : "";
}

function isLegacyGenericCaption(caption: string) {
  const value = caption.trim();
  return /^(זיכרון מהאלבום|רגע(?: רחב| קרוב| מרובע)?\b.*מהאלבום)/.test(value);
}

function imageToCaptionDataUrl(photo: Photo) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const maxSize = 1600;
      const ratio = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * ratio));
      const height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("לא ניתן לקרוא את התמונה בדפדפן."));
        return;
      }

      canvas.width = width;
      canvas.height = height;
      context.drawImage(image, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.9));
    };
    image.onerror = () => reject(new Error("לא ניתן לטעון את התמונה לזיהוי."));
    image.src = photo.url;
  });
}

export default function Home() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [photosPerPage, setPhotosPerPage] = useState(4);
  const [title, setTitle] = useState("אלבום התמונות שלי");
  const [subtitle, setSubtitle] = useState("זכרונות מסודרים להדפסה");
  const [note, setNote] = useState("אפשר להחליף כאן לכל טקסט שתרצי");
  const coverDialog = useRef<HTMLDialogElement>(null);
  const [coverEdit, setCoverEdit] = useState<{ label: string; value: string; automatic?: string; save: (value: string) => void } | null>(null);

  function editCoverText(label: string, value: string, save: (value: string) => void, automatic?: string) {
    flushSync(() => setCoverEdit({ label, value, save, automatic }));
    coverDialog.current?.showModal();
    coverDialog.current?.querySelector("textarea")?.focus();
  }

  const [coverDateText, setCoverDateText] = useState("");
  const [coverPhotoId, setCoverPhotoId] = useState("none");
  const [customCover, setCustomCover] = useState<CoverImage | null>(null);
  const [showPhotoDates, setShowPhotoDates] = useState(true);
  const [pageContent, setPageContent] = useState<Record<string, PageContent>>({});
  const [pageLayouts, setPageLayouts] = useState<Record<string, PageLayout>>({});
  const [photoCaptions, setPhotoCaptions] = useState<Record<string, string>>({});
  const [captionSources, setCaptionSources] = useState<Record<string, CaptionSource>>({});
  const [status, setStatus] = useState("בודקת אם נשמר אלבום קודם בדפדפן...");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [debug, setDebug] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [captionMode, setCaptionMode] = useState<CaptionMode>("basic");
  const [placeHint, setPlaceHint] = useState("");
  const [albumFont, setAlbumFont] = useState<AlbumFont>(DEFAULT_ALBUM_FONT);
  const [pageDecorations, setPageDecorations] = useState<Record<string, PageDecoration>>({});
  const [showRoutePage, setShowRoutePage] = useState(false);
  const [routeTitle, setRouteTitle] = useState("מסלול הטיול");
  const [routePlaces, setRoutePlaces] = useState<string[]>(DEFAULT_ROUTE_PLACES);
  const [analyzingCaptions, setAnalyzingCaptions] = useState<Record<string, boolean>>({});
  const [savedAt, setSavedAt] = useState("");
  const [hasCheckedSavedAlbum, setHasCheckedSavedAlbum] = useState(false);
  const [isSavingAlbum, setIsSavingAlbum] = useState(false);
  const [isExportingAlbum, setIsExportingAlbum] = useState(false);
  const [photoLibraries, setPhotoLibraries] = useState<PhotoLibrary[]>([]);
  const [newLibraryName, setNewLibraryName] = useState("");
  const [activeLibraryId, setActiveLibraryId] = useState("");
  const [selectedLibraryPhotoIds, setSelectedLibraryPhotoIds] = useState<Set<string>>(new Set());
  const [libraryPreviewUrls, setLibraryPreviewUrls] = useState<Record<string, string>>({});
  const [isSavingLibrary, setIsSavingLibrary] = useState(false);
  const [undoSnapshot, setUndoSnapshot] = useState<AlbumSnapshot | null>(null);
  const [undoLabel, setUndoLabel] = useState("");
  const [redoSnapshot, setRedoSnapshot] = useState<AlbumSnapshot | null>(null);
  const [redoLabel, setRedoLabel] = useState("");
  const [currentSpread, setCurrentSpread] = useState(0);
  const [draggedPhotoId, setDraggedPhotoId] = useState("");
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [adjustingPhotoId, setAdjustingPhotoId] = useState("");
  const adjustingPhoto = photos.find((photo) => photo.id === adjustingPhotoId);

  function savePhotoAdjust(photoId: string, zoom: number, crop: PhotoCrop | undefined) {
    rememberUndo("שינוי גודל וחיתוך");
    setPhotos((current) => current.map((photo) => (
      photo.id === photoId ? { ...photo, zoom: cleanZoom(zoom), crop } : photo
    )));
  }
  const savePhotoAdjustRef = useRef(savePhotoAdjust);
  savePhotoAdjustRef.current = savePhotoAdjust;
  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Two-finger pinch on a photo in the album: spread to enlarge, pinch to shrink. Proportions are kept.
  useEffect(() => {
    let pinch: { frame: HTMLElement; photoId: string; startDistance: number; startZoom: number; zoom: number } | null = null;
    const distance = (touches: TouchList) => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
    function onStart(event: TouchEvent) {
      if (event.touches.length !== 2) return;
      const target = event.target as Element | null;
      const frame = target?.closest?.(".photo-grid .photo-frame[data-photo-id]") as HTMLElement | null;
      if (!frame) return;
      const photoId = frame.dataset.photoId || "";
      const photo = photosRef.current.find((item) => item.id === photoId);
      if (!photo) return;
      const startZoom = photo.zoom ?? 1;
      pinch = { frame, photoId, startDistance: Math.max(distance(event.touches), 1), startZoom, zoom: startZoom };
      frame.classList.add("is-pinching");
    }
    function onMove(event: TouchEvent) {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const zoom = clampNumber(pinch.startZoom * (distance(event.touches) / pinch.startDistance), MIN_ZOOM, MAX_ZOOM);
      pinch.zoom = zoom;
      pinch.frame.style.setProperty("--size", String(Math.min(zoom, 1)));
      pinch.frame.style.setProperty("--zoom", String(Math.max(zoom, 1)));
    }
    function onEnd() {
      if (!pinch) return;
      const { frame, photoId, startZoom, zoom } = pinch;
      pinch = null;
      frame.classList.remove("is-pinching");
      if (Math.abs(zoom - startZoom) < 0.02) return;
      const photo = photosRef.current.find((item) => item.id === photoId);
      savePhotoAdjustRef.current(photoId, zoom, photo?.crop);
    }
    // Stops Safari from zooming the whole page while a photo is being pinched.
    function onGesture(event: Event) {
      if (pinch) event.preventDefault();
    }
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    document.addEventListener("gesturestart", onGesture);
    document.addEventListener("gesturechange", onGesture);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
      document.removeEventListener("gesturestart", onGesture);
      document.removeEventListener("gesturechange", onGesture);
    };
  }, []);
  const [duplicateRemovals, setDuplicateRemovals] = useState<Set<string>>(new Set());
  const [keptDuplicateGroups, setKeptDuplicateGroups] = useState<Set<string>>(new Set());
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analyzingIds = useRef<Set<string>>(new Set());

  const albumPhotos = photos;
  const duplicateGroups = useMemo(
    () => findSimilarGroups(photos).filter((group) => !keptDuplicateGroups.has(group.map((photo) => photo.id).sort().join("|"))),
    [photos, keptDuplicateGroups],
  );

  // Photos saved before duplicate detection existed get their fingerprint in the background, one at a time.
  useEffect(() => {
    const pending = photos.find((photo) => !photo.hash && !analyzingIds.current.has(photo.id));
    if (!pending) return;
    analyzingIds.current.add(pending.id);
    readImageDetails(pending.url).then((details) => {
      setPhotos((current) => current.map((photo) => (
        photo.id === pending.id
          ? { ...photo, hash: details.hash || "-", sharpness: details.sharpness, exposure: details.exposure }
          : photo
      )));
    });
  }, [photos]);

  function openDuplicateReview() {
    const removals = new Set<string>();
    duplicateGroups.forEach((group) => {
      const best = bestPhotoOf(group);
      group.forEach((photo) => {
        if (photo.id !== best.id) removals.add(photo.id);
      });
    });
    setDuplicateRemovals(removals);
    setShowDuplicates(true);
  }

  function toggleDuplicateRemoval(photoId: string) {
    setDuplicateRemovals((current) => {
      const next = new Set(current);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  }

  function keepDuplicateGroup(group: Photo[]) {
    setKeptDuplicateGroups((current) => new Set(current).add(group.map((photo) => photo.id).sort().join("|")));
    setDuplicateRemovals((current) => {
      const next = new Set(current);
      group.forEach((photo) => next.delete(photo.id));
      return next;
    });
  }

  function removePhotos(ids: Set<string>, label: string) {
    if (!ids.size) return;
    rememberUndo(label);
    // A removed photo that opened a page hands that page's settings to the next photo that stays.
    const nextKeptId = (photoId: string) => {
      const start = photos.findIndex((photo) => photo.id === photoId);
      return photos.slice(start + 1).find((photo) => !ids.has(photo.id))?.id;
    };
    const handOver = <T,>(map: Record<string, T>) => {
      const next = { ...map };
      ids.forEach((photoId) => {
        if (!(photoId in next)) return;
        const heir = nextKeptId(photoId);
        if (heir && !(heir in next)) next[heir] = next[photoId];
        delete next[photoId];
      });
      return next;
    };
    const withoutIds = <T,>(map: Record<string, T>) => {
      const next = { ...map };
      ids.forEach((photoId) => delete next[photoId]);
      return next;
    };
    setPageContent(handOver);
    setPageLayouts(handOver);
    setPageDecorations(handOver);
    setPhotoCaptions(withoutIds);
    setCaptionSources(withoutIds);
    setPhotos((current) => current.filter((photo) => !ids.has(photo.id)));
    if (ids.has(coverPhotoId)) setCoverPhotoId("none");
  }

  function removeChosenDuplicates() {
    const count = duplicateRemovals.size;
    removePhotos(duplicateRemovals, "הסרת תמונות כפולות");
    setDuplicateRemovals(new Set());
    setShowDuplicates(false);
    setStatus(`הוסרו ${count} תמונות כפולות או דומות. אפשר לבטל עם "בטל פעולה אחרונה".`);
  }
  const activePhotoLibrary = photoLibraries.find((library) => library.id === activeLibraryId) || null;
  const dateSortedPhotos = useMemo(() => sortPhotosByDate(photos), [photos]);
  const pages = useMemo(
    () => paginatePhotos(albumPhotos, photosPerPage, pageLayouts),
    [albumPhotos, pageLayouts, photosPerPage],
  );
  const dateRange = dateSortedPhotos.length
    ? `${formatDate(dateSortedPhotos[0].date)} - ${formatDate(dateSortedPhotos[dateSortedPhotos.length - 1].date)}`
    : "עדיין לא הועלו תמונות";
  const coverImage = coverPhotoId === "custom"
    ? customCover
    : albumPhotos.find((photo) => photo.id === coverPhotoId) || null;
  const coverDate = coverDateText.trim() || dateRange;
  const printablePages = useMemo<PrintablePage[]>(() => [
    { type: "cover" },
    { type: "coverBack" },
    ...(showRoutePage ? [{ type: "route" as const }] : []),
    ...(pages.length
      ? pages.flatMap<PrintablePage>((albumPage) => (
          albumPage.capacity === 1 && albumPage.singlePhotoMode === "spread" && albumPage.pagePhotos.length === 1
            ? [
                { type: "photoSpreadHalf" as const, albumPage, side: "start" as const },
                { type: "photoSpreadHalf" as const, albumPage, side: "end" as const },
              ]
            : [{ type: "photo" as const, albumPage }]
        ))
    : [{ type: "empty" as const }]),
  ], [pages, showRoutePage]);
  const previewContentPageCount = Math.max(0, printablePages.length - 2);
  const totalSpreads = Math.max(1, 1 + Math.ceil(previewContentPageCount / 2));
  const activeSpread = Math.min(currentSpread, totalSpreads - 1);
  const visiblePageIndexes = activeSpread === 0
    ? [0]
    : [2 + (activeSpread - 1) * 2, 3 + (activeSpread - 1) * 2]
      .filter((index) => index < printablePages.length);
  const spreadLabel = activeSpread === 0 ? "כריכה" : `כפולה ${activeSpread} מתוך ${totalSpreads - 1}`;

  function addDebug(message: string) {
    setDebug((items) => [...items, `${new Date().toLocaleTimeString("he-IL")} ${message}`]);
  }

  function createUndoSnapshot(): AlbumSnapshot {
    return {
      photos: [...photos],
      photosPerPage,
      title,
      subtitle,
      note,
      coverDateText,
      coverPhotoId,
      customCover,
      showPhotoDates,
      pageContent: { ...pageContent },
      pageLayouts: { ...pageLayouts },
      photoCaptions: { ...photoCaptions },
      captionSources: { ...captionSources },
      captionMode,
      placeHint,
      albumFont,
      pageDecorations: { ...pageDecorations },
      showRoutePage,
      routeTitle,
      routePlaces: [...routePlaces],
    };
  }

  function rememberUndo(label: string) {
    setUndoSnapshot(createUndoSnapshot());
    setUndoLabel(label);
    setRedoSnapshot(null);
    setRedoLabel("");
  }

  function restoreUndoSnapshot() {
    if (!undoSnapshot) {
      setStatus("אין פעולה אחרונה לביטול כרגע.");
      return;
    }

    const redoState = createUndoSnapshot();
    setPhotos(undoSnapshot.photos);
    setPhotosPerPage(undoSnapshot.photosPerPage);
    setTitle(undoSnapshot.title);
    setSubtitle(undoSnapshot.subtitle);
    setNote(undoSnapshot.note);
    setCoverDateText(undoSnapshot.coverDateText);
    setCoverPhotoId(undoSnapshot.coverPhotoId);
    setCustomCover(undoSnapshot.customCover);
    setShowPhotoDates(undoSnapshot.showPhotoDates);
    setPageContent(undoSnapshot.pageContent);
    setPageLayouts(undoSnapshot.pageLayouts);
    setPhotoCaptions(undoSnapshot.photoCaptions);
    setCaptionSources(undoSnapshot.captionSources);
    setCaptionMode(undoSnapshot.captionMode);
    setPlaceHint(undoSnapshot.placeHint);
    setAlbumFont(undoSnapshot.albumFont);
    setPageDecorations(undoSnapshot.pageDecorations);
    setShowRoutePage(undoSnapshot.showRoutePage);
    setRouteTitle(undoSnapshot.routeTitle);
    setRoutePlaces(undoSnapshot.routePlaces);
    setRedoSnapshot(redoState);
    setRedoLabel(undoLabel);
    setUndoSnapshot(null);
    setUndoLabel("");
    setStatus("הפעולה האחרונה בוטלה. האלבום חזר למצב הקודם.");
  }

  function restoreRedoSnapshot() {
    if (!redoSnapshot) {
      setStatus("אין פעולה לביצוע מחדש כרגע.");
      return;
    }

    const undoState = createUndoSnapshot();
    setPhotos(redoSnapshot.photos);
    setPhotosPerPage(redoSnapshot.photosPerPage);
    setTitle(redoSnapshot.title);
    setSubtitle(redoSnapshot.subtitle);
    setNote(redoSnapshot.note);
    setCoverDateText(redoSnapshot.coverDateText);
    setCoverPhotoId(redoSnapshot.coverPhotoId);
    setCustomCover(redoSnapshot.customCover);
    setShowPhotoDates(redoSnapshot.showPhotoDates);
    setPageContent(redoSnapshot.pageContent);
    setPageLayouts(redoSnapshot.pageLayouts);
    setPhotoCaptions(redoSnapshot.photoCaptions);
    setCaptionSources(redoSnapshot.captionSources);
    setCaptionMode(redoSnapshot.captionMode);
    setPlaceHint(redoSnapshot.placeHint);
    setAlbumFont(redoSnapshot.albumFont);
    setPageDecorations(redoSnapshot.pageDecorations);
    setShowRoutePage(redoSnapshot.showRoutePage);
    setRouteTitle(redoSnapshot.routeTitle);
    setRoutePlaces(redoSnapshot.routePlaces);
    setUndoSnapshot(undoState);
    setUndoLabel(redoLabel);
    setRedoSnapshot(null);
    setRedoLabel("");
    setStatus("הפעולה בוצעה מחדש.");
  }

  function swapPhotos(sourceId: string, targetId: string) {
    if (!sourceId || sourceId === targetId) return;

    rememberUndo("החלפת מיקום תמונות");
    setPhotos((currentPhotos) => {
      const sourceIndex = currentPhotos.findIndex((photo) => photo.id === sourceId);
      const targetIndex = currentPhotos.findIndex((photo) => photo.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return currentPhotos;

      const nextPhotos = [...currentPhotos];
      [nextPhotos[sourceIndex], nextPhotos[targetIndex]] = [nextPhotos[targetIndex], nextPhotos[sourceIndex]];
      return nextPhotos;
    });
    // Page settings stay with the page position, not with the photo that moved away.
    const swapKeys = <T,>(map: Record<string, T>) => {
      const next = { ...map };
      const sourceValue = map[sourceId];
      const targetValue = map[targetId];
      delete next[sourceId];
      delete next[targetId];
      if (targetValue !== undefined) next[sourceId] = targetValue;
      if (sourceValue !== undefined) next[targetId] = sourceValue;
      return next;
    };
    setPageContent(swapKeys);
    setPageLayouts(swapKeys);
    setPageDecorations(swapKeys);
    setStatus("התמונות החליפו מקום. הכיתובים והעריכות נשארו צמודים לכל תמונה.");
  }

  function movePhotoToIndex(sourceId: string, targetIndex: number, label = "העברת תמונה למשבצת פנויה") {
    if (!sourceId) return;

    rememberUndo(label);
    setPhotos((currentPhotos) => {
      const sourceIndex = currentPhotos.findIndex((photo) => photo.id === sourceId);
      if (sourceIndex < 0) return currentPhotos;

      const nextPhotos = [...currentPhotos];
      const [movedPhoto] = nextPhotos.splice(sourceIndex, 1);
      const insertionIndex = Math.max(0, Math.min(targetIndex, nextPhotos.length));
      nextPhotos.splice(insertionIndex, 0, movedPhoto);
      return nextPhotos;
    });
    setStatus("התמונה הועברה למשבצת הפנויה. כל הכיתובים והעריכות עברו איתה.");
  }

  function finishPhotoDrop(target: DropTarget) {
    if (!draggedPhotoId || !target) return;

    if (target.type === "photo") swapPhotos(draggedPhotoId, target.id);
    if (target.type === "empty") movePhotoToIndex(draggedPhotoId, target.index);

    setDraggedPhotoId("");
    setDropTarget(null);
  }

  function duplicatePhoto(photo: Photo) {
    rememberUndo("שכפול תמונה");
    const duplicatedPhoto = {
      ...photo,
      id: `${photo.id}-copy-${Date.now()}`,
      name: `${photo.name} עותק`,
      signature: undefined,
    };
    setPhotos((currentPhotos) => {
      const nextPhotos = [...currentPhotos];
      const photoIndex = nextPhotos.findIndex((item) => item.id === photo.id);
      nextPhotos.splice(photoIndex >= 0 ? photoIndex + 1 : nextPhotos.length, 0, duplicatedPhoto);
      return nextPhotos;
    });
    setPhotoCaptions((captions) => ({
      ...captions,
      [duplicatedPhoto.id]: captions[photo.id] || "",
    }));
    setCaptionSources((sources) => ({
      ...sources,
      ...(sources[photo.id] ? { [duplicatedPhoto.id]: sources[photo.id] } : {}),
    }));
    setStatus("התמונה שוכפלה ליד המקור.");
  }

  function movePhotoToPage(photo: Photo, pageNumber: number) {
    const targetPage = pages[pageNumber - 1];
    if (!targetPage) return;
    movePhotoToIndex(photo.id, targetPage?.startIndex ?? 0, "העברת תמונה לעמוד אחר");
  }

  async function replacePhoto(event: ChangeEvent<HTMLInputElement>, photo: Photo) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    if (!isSupportedImageFile(file)) {
      setStatus("הקובץ שנבחר לא זוהה כתמונה.");
      input.value = "";
      return;
    }

    setIsLoading(true);
    setStatus("מחליפה את התמונה ושומרת את מיקומה בעמוד...");

    try {
      const [displayBlob, metadata] = await Promise.all([fileToDisplayBlob(file), readPhotoMetadata(file)]);
      const url = URL.createObjectURL(displayBlob);
      const imageDetails = await readImageDetails(url);
      if (!imageDetails.width || !imageDetails.height) {
        URL.revokeObjectURL(url);
        throw new Error("לא ניתן להציג את הקובץ שנבחר");
      }
      rememberUndo("החלפת תמונה");
      setPhotos((currentPhotos) => currentPhotos.map((item) => (
        item.id === photo.id
          ? {
              ...item,
              name: file.name,
              url,
              signature: fileSignature(file),
              date: photoDateFrom(file, metadata),
              detectedPlace: undefined,
              crop: undefined,
              zoom: undefined,
              latitude: metadata.latitude,
              longitude: metadata.longitude,
              ...imageDetails,
            }
          : item
      )));
      setPhotoCaptions((captions) => ({ ...captions, [photo.id]: "" }));
      setCaptionSources((sources) => {
        const nextSources = { ...sources };
        delete nextSources[photo.id];
        return nextSources;
      });
      setStatus("התמונה הוחלפה באותו מקום בעמוד. התאריך והכיתוב עודכנו לתמונה החדשה.");
      input.closest("details")?.removeAttribute("open");
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`החלפת תמונה נכשלה: ${message}`);
      setStatus("לא הצלחתי להחליף את התמונה. נסי לבחור תמונה אחרת.");
    } finally {
      setIsLoading(false);
      input.value = "";
    }
  }

  function rememberFieldEdit(label: string) {
    rememberUndo(label);
  }

  function changePhotosPerPage(value: number) {
    rememberUndo("שינוי כמות תמונות בעמוד");
    setPhotosPerPage(value);
  }

  function changePagePhotoCount(pageKey: string, pageNumber: number, value: number) {
    rememberUndo("שינוי כמות תמונות בעמוד");
    setPageLayouts((layouts) => ({
      ...layouts,
      [pageKey]: {
        ...layouts[pageKey],
        photosPerPage: value,
        singlePhotoMode: value === 1 ? layouts[pageKey]?.singlePhotoMode || "page" : "page",
      },
    }));
    setStatus(`עודכן עמוד ${pageNumber}: עד ${value} תמונות בעמוד.`);
  }

  function changeSinglePhotoMode(pageKey: string, value: SinglePhotoMode) {
    rememberUndo("שינוי פריסת תמונה בודדת");
    setPageLayouts((layouts) => ({
      ...layouts,
      [pageKey]: {
        ...layouts[pageKey],
        photosPerPage: 1,
        singlePhotoMode: value,
      },
    }));
    setStatus(value === "spread"
      ? "התמונה נפרסת על כפולה פתוחה. שימי לב לסימון החיבור באמצע לפני הדפסה."
      : "התמונה נפרסת על עמוד אחד מלא.");
  }

  function changeCoverPhoto(value: string) {
    rememberUndo("שינוי תמונת כריכה");
    setCoverPhotoId(value);
  }

  function changeCaptionMode(value: CaptionMode) {
    rememberUndo("שינוי סוג כיתוב");
    setCaptionMode(value);
  }

  function changeAlbumFont(value: AlbumFont) {
    rememberUndo("שינוי גופן");
    setAlbumFont(value);
  }

  function changeShowPhotoDates(value: boolean) {
    rememberUndo("הצגת תאריכים");
    setShowPhotoDates(value);
  }

  function changeShowRoutePage(value: boolean) {
    rememberUndo("עמוד מסלול");
    setShowRoutePage(value);
  }

  function updateRoutePlace(index: number, value: string) {
    setRoutePlaces((places) => places.map((place, placeIndex) => (
      placeIndex === index ? value : place
    )));
  }

  function addRoutePlace() {
    rememberUndo("הוספת יעד למסלול");
    setRoutePlaces((places) => [...places, "יעד חדש"]);
  }

  function removeRoutePlace(index: number) {
    if (routePlaces.length <= 2) {
      setStatus("כדי לצייר מסלול צריך לפחות שני יעדים.");
      return;
    }

    rememberUndo("מחיקת יעד מהמסלול");
    setRoutePlaces((places) => places.filter((_, placeIndex) => placeIndex !== index));
  }

  useEffect(() => {
    let isMounted = true;

    readSavedAlbum()
      .then((album) => {
        if (isMounted && album?.savedAt) {
          applyStoredAlbum(album, `הטיוטה האחרונה נטענה אוטומטית מ-${new Date(album.savedAt).toLocaleString("he-IL")}. אפשר להמשיך מאותו מקום.`);
        } else if (isMounted) {
          setStatus("בחרי תמונות מהכפתור למעלה. אחרי האישור הן יופיעו כאן מיד.");
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
        addDebug(`בדיקת אלבום שמור נכשלה: ${message}`);
      })
      .finally(() => {
        if (isMounted) setHasCheckedSavedAlbum(true);
      });

    return () => {
      isMounted = false;
    };
    // Runs only once on page load to restore the latest browser draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let isMounted = true;
    readPhotoLibraries()
      .then((libraries) => {
        if (!isMounted) return;
        setPhotoLibraries(libraries);
        if (libraries.length) setActiveLibraryId((current) => current || libraries[0].id);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
        addDebug(`טעינת מאגר התמונות נכשלה: ${message}`);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const urls: Record<string, string> = {};
    activePhotoLibrary?.photos.forEach((photo) => {
      urls[photo.id] = URL.createObjectURL(photo.blob);
    });
    setLibraryPreviewUrls(urls);
    setSelectedLibraryPhotoIds(new Set());
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [activePhotoLibrary]);

  useEffect(() => {
    if (!hasCheckedSavedAlbum || isLoading || isSavingAlbum || isExportingAlbum) return;
    if (!photos.length && !customCover) return;

    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);

    autosaveTimer.current = setTimeout(() => {
      createStoredAlbum()
        .then((album) => writeSavedAlbum(album).then(() => album))
        .then((album) => {
          setSavedAt(album.savedAt);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
          addDebug(`שמירה אוטומטית נכשלה: ${message}`);
        });
    }, 3000);

    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
    // createStoredAlbum intentionally uses the latest state captured by this autosave effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    albumFont,
    captionMode,
    captionSources,
    coverDateText,
    coverPhotoId,
    customCover,
    hasCheckedSavedAlbum,
    isExportingAlbum,
    isLoading,
    isSavingAlbum,
    note,
    pageContent,
    pageDecorations,
    pageLayouts,
    photoCaptions,
    photos,
    photosPerPage,
    placeHint,
    routePlaces,
    routeTitle,
    showPhotoDates,
    showRoutePage,
    subtitle,
    title,
  ]);

  function updatePageContent(pageKey: string, field: keyof PageContent, value: string) {
    setPageContent((content) => ({
      ...content,
      [pageKey]: {
        ...content[pageKey],
        [field]: value,
      },
    }));
  }

  function setCaptionSource(photoId: string, source?: CaptionSource) {
    setCaptionSources((sources) => {
      const nextSources = { ...sources };
      if (source) nextSources[photoId] = source;
      else delete nextSources[photoId];
      return nextSources;
    });
  }

  function updatePhotoCaption(photoId: string, value: string, source: CaptionSource = "manual") {
    setPhotoCaptions((captions) => ({
      ...captions,
      [photoId]: value,
    }));
    setCaptionSource(photoId, value.trim() ? source : undefined);
  }

  function suggestPhotoCaption(photo: Photo) {
    const caption = suggestedCaption(photo);
    if (!caption) {
      setStatus("לא נמצא זיהוי אמיתי לתמונה. השארתי את הכיתוב ריק והצגתי רק את התאריך.");
      return;
    }
    rememberUndo("הצעת כיתוב");
    updatePhotoCaption(photo.id, caption, "auto");
  }

  function suggestAllCaptions() {
    rememberUndo("הצעת כיתובים");
    setPhotoCaptions((captions) => {
      const nextCaptions = { ...captions };
      albumPhotos.forEach((photo) => {
        if (!nextCaptions[photo.id]?.trim()) {
          const caption = suggestedCaption(photo);
          if (caption) nextCaptions[photo.id] = caption;
        }
      });
      return nextCaptions;
    });
    setCaptionSources((sources) => {
      const nextSources = { ...sources };
      albumPhotos.forEach((photo) => {
        if (!photoCaptions[photo.id]?.trim() && suggestedCaption(photo)) nextSources[photo.id] = "auto";
      });
      return nextSources;
    });
    setStatus("נוספו כיתובים רק לתמונות שבהן זוהה מקום אמיתי. בשאר התמונות הכיתוב נשאר ריק.");
  }

  async function createStoredAlbum(savedAtValue = new Date().toISOString()): Promise<StoredAlbum> {
    const storedPhotos = await Promise.all(
      albumPhotos.map(async (photo) => ({
        id: photo.id,
        name: photo.name,
        signature: photo.signature,
        date: photo.date.toISOString(),
        width: photo.width,
        height: photo.height,
        brightness: photo.brightness,
        hash: photo.hash,
        sharpness: photo.sharpness,
        exposure: photo.exposure,
        zoom: photo.zoom,
        crop: photo.crop,
        latitude: photo.latitude,
        longitude: photo.longitude,
        detectedPlace: photo.detectedPlace,
        blob: await urlToBlob(photo.url),
      })),
    );
    const storedCover = customCover
      ? {
          id: customCover.id,
          name: customCover.name,
          blob: await urlToBlob(customCover.url),
        }
      : null;

    return {
      id: CURRENT_ALBUM_ID,
      savedAt: savedAtValue,
      photos: storedPhotos,
      photosPerPage,
      title,
      subtitle,
      note,
      coverDateText,
      coverPhotoId,
      customCover: storedCover,
      showPhotoDates,
      dateDisplayPreferenceVersion: 1,
      pageContent,
      pageLayouts,
      photoCaptions,
      captionSources,
      captionMode,
      placeHint,
      albumFont,
      pageDecorations,
      showRoutePage,
      routeTitle,
      routePlaces,
    };
  }

  async function applyStoredAlbum(album: StoredAlbum, message: string) {
    photos.forEach((photo) => {
      if (photo.url.startsWith("blob:")) URL.revokeObjectURL(photo.url);
    });
    if (customCover?.url.startsWith("blob:")) URL.revokeObjectURL(customCover.url);

    const restoredPhotos = album.photos.map((photo) => ({
        id: photo.id,
        name: photo.name,
        url: URL.createObjectURL(photo.blob),
        signature: photo.signature,
        date: new Date(photo.date),
        width: photo.width,
        height: photo.height,
        brightness: photo.brightness,
        hash: photo.hash,
        sharpness: photo.sharpness,
        exposure: photo.exposure,
        zoom: photo.zoom,
        crop: photo.crop,
        detectedPlace: photo.detectedPlace,
        latitude: photo.latitude,
        longitude: photo.longitude,
      }));
    setPhotos(restoredPhotos);
    setCustomCover(album.customCover
      ? {
          id: album.customCover.id,
          name: album.customCover.name,
          url: URL.createObjectURL(album.customCover.blob),
        }
      : null);
    setPhotosPerPage(album.photosPerPage);
    setTitle(album.title);
    setSubtitle(album.subtitle);
    setNote(album.note);
    setCoverDateText(album.coverDateText);
    setCoverPhotoId(album.coverPhotoId);
    setShowPhotoDates(album.dateDisplayPreferenceVersion === 1 ? album.showPhotoDates : true);
    const pageStartIds = numericPageStartIds(
      restoredPhotos.map((photo) => photo.id),
      album.photosPerPage,
      album.pageLayouts,
    );
    setPageContent(migratePageKeyedMap(album.pageContent, pageStartIds));
    setPageLayouts(migratePageKeyedMap(album.pageLayouts, pageStartIds));
    setPageDecorations(migratePageKeyedMap(album.pageDecorations, pageStartIds));
    const restoredCaptions = { ...(album.photoCaptions || {}) };
    const restoredSources = { ...(album.captionSources || {}) };
    Object.entries(restoredCaptions).forEach(([photoId, caption]) => {
      if (isLegacyGenericCaption(caption)) {
        restoredCaptions[photoId] = "";
        delete restoredSources[photoId];
      }
    });
    setPhotoCaptions(restoredCaptions);
    setCaptionSources(restoredSources);
    setCaptionMode(album.captionMode || "basic");
    setPlaceHint(album.placeHint || "");
    setAlbumFont(album.albumFont || DEFAULT_ALBUM_FONT);
    setShowRoutePage(Boolean(album.showRoutePage));
    setRouteTitle(album.routeTitle || "מסלול הטיול");
    setRoutePlaces(album.routePlaces?.length ? album.routePlaces : DEFAULT_ROUTE_PLACES);
    setSavedAt(album.savedAt);
    setStatus(message);
  }

  async function saveAlbumForLater() {
    if (!photos.length && !customCover) {
      setStatus("אין עדיין אלבום לשמירה. בחרי תמונות ואז שמרי.");
      return;
    }

    setIsSavingAlbum(true);
    setStatus("שומרת את האלבום בדפדפן. בתמונות רבות זה יכול לקחת רגע.");

    try {
      const savedAlbum = await createStoredAlbum();
      await writeSavedAlbum(savedAlbum);
      setSavedAt(savedAlbum.savedAt);
      setStatus("האלבום נשמר. אפשר לסגור ולחזור אחר כך מאותו מכשיר ודפדפן.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`שמירת אלבום נכשלה: ${message}`);
      setStatus("לא הצלחתי לשמור את כל האלבום. אם יש הרבה תמונות, נסי לשמור פחות תמונות בכל אלבום.");
    } finally {
      setIsSavingAlbum(false);
    }
  }

  async function loadSavedAlbumForLater() {
    setIsLoading(true);
    setStatus("טוענת את האלבום השמור...");

    try {
      const album = await readSavedAlbum();
      if (!album) {
        setStatus("לא נמצא אלבום שמור בדפדפן הזה.");
        return;
      }

      await applyStoredAlbum(album, "האלבום השמור נטען. אפשר להמשיך לערוך ולהדפיס.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`טעינת אלבום שמור נכשלה: ${message}`);
      setStatus("לא הצלחתי לטעון את האלבום השמור.");
    } finally {
      setIsLoading(false);
    }
  }

  async function deleteSavedAlbumForLater() {
    try {
      await removeSavedAlbum();
      setSavedAt("");
      setStatus("השמירה נמחקה מהדפדפן. האלבום שמוצג עכשיו לא נמחק מהמסך.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`מחיקת אלבום שמור נכשלה: ${message}`);
      setStatus("לא הצלחתי למחוק את השמירה.");
    }
  }

  async function exportAlbumToFile() {
    if (!photos.length && !customCover) {
      setStatus("אין עדיין אלבום לייצוא. בחרי תמונות ואז ייצאי.");
      return;
    }

    setIsExportingAlbum(true);
    setStatus("מכינה קובץ אלבום. בתמונות רבות זה יכול לקחת רגע.");

    try {
      const storedAlbum = await createStoredAlbum();
      const exportedAlbum: ExportedAlbum = {
        ...storedAlbum,
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        photos: await Promise.all(storedAlbum.photos.map(async ({ blob, ...photo }) => ({
          ...photo,
          dataUrl: await blobToDataUrl(blob),
        }))),
        customCover: storedAlbum.customCover
          ? {
              id: storedAlbum.customCover.id,
              name: storedAlbum.customCover.name,
              dataUrl: await blobToDataUrl(storedAlbum.customCover.blob),
            }
          : null,
      };
      const albumBlob = new Blob([JSON.stringify(exportedAlbum)], { type: "application/json" });
      const url = URL.createObjectURL(albumBlob);
      const date = new Date().toISOString().slice(0, 10);
      const link = document.createElement("a");
      link.href = url;
      link.download = `album-${date}.tamar-album.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      await writeSavedAlbum(storedAlbum);
      setSavedAt(storedAlbum.savedAt);
      setStatus("קובץ האלבום ירד למכשיר. אפשר להעביר אותו למחשב ולייבא שם.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`ייצוא אלבום נכשל: ${message}`);
      setStatus("לא הצלחתי להכין קובץ אלבום. אם יש הרבה תמונות, נסי אלבום קטן יותר.");
    } finally {
      setIsExportingAlbum(false);
    }
  }

  async function importAlbumFromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setStatus("מייבאת את קובץ האלבום...");

    try {
      const imported = JSON.parse(await file.text()) as Partial<ExportedAlbum>;
      if (imported.exportVersion !== 1 || !Array.isArray(imported.photos)) {
        throw new Error("זה לא נראה כמו קובץ אלבום מתאים.");
      }
      rememberUndo("ייבוא אלבום");

      const importedAlbum: StoredAlbum = {
        id: CURRENT_ALBUM_ID,
        savedAt: new Date().toISOString(),
        photos: await Promise.all(imported.photos.map(async (photo) => ({
          id: photo.id || `imported-${Date.now()}-${Math.random()}`,
          name: photo.name || "תמונה מיובאת",
          signature: photo.signature,
          date: photo.date || new Date().toISOString(),
          width: photo.width,
          height: photo.height,
          brightness: photo.brightness,
          hash: photo.hash,
          sharpness: photo.sharpness,
          exposure: photo.exposure,
          zoom: cleanZoom(photo.zoom),
          crop: cleanCrop(photo.crop),
          latitude: photo.latitude,
          longitude: photo.longitude,
          detectedPlace: photo.detectedPlace,
          blob: await dataUrlToBlob(photo.dataUrl),
        }))),
        photosPerPage: imported.photosPerPage || 4,
        title: imported.title || "אלבום התמונות שלי",
        subtitle: imported.subtitle || "זכרונות מסודרים להדפסה",
        note: imported.note || "",
        coverDateText: imported.coverDateText || "",
        coverPhotoId: imported.coverPhotoId || "none",
        customCover: imported.customCover
          ? {
              id: imported.customCover.id || `cover-${Date.now()}`,
              name: imported.customCover.name || "כריכה מיובאת",
              blob: await dataUrlToBlob(imported.customCover.dataUrl),
            }
          : null,
        showPhotoDates: imported.dateDisplayPreferenceVersion === 1 ? Boolean(imported.showPhotoDates) : true,
        dateDisplayPreferenceVersion: 1,
        pageContent: imported.pageContent || {},
        pageLayouts: imported.pageLayouts || {},
        photoCaptions: imported.photoCaptions || {},
        captionSources: imported.captionSources || {},
        captionMode: imported.captionMode || "basic",
        placeHint: imported.placeHint || "",
        albumFont: imported.albumFont || DEFAULT_ALBUM_FONT,
        pageDecorations: imported.pageDecorations || {},
        showRoutePage: Boolean(imported.showRoutePage),
        routeTitle: imported.routeTitle || "מסלול הטיול",
        routePlaces: imported.routePlaces?.length ? imported.routePlaces : DEFAULT_ROUTE_PLACES,
      };

      await applyStoredAlbum(importedAlbum, "האלבום יובא. שמרתי אותו גם בדפדפן הזה להמשך עבודה.");
      await writeSavedAlbum(importedAlbum);
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`ייבוא אלבום נכשל: ${message}`);
      setStatus(`לא הצלחתי לייבא את האלבום. ${message}`);
    } finally {
      setIsLoading(false);
      event.target.value = "";
    }
  }

  // Returns true when it asked the place-name service, so batch runs can pace themselves.
  async function identifyPhotoCaption(photo: Photo, trackUndo = true) {
    if (trackUndo) rememberUndo("זיהוי כיתוב");
    setAnalyzingCaptions((items) => ({ ...items, [photo.id]: true }));
    setStatus(`מזהה את ${photo.name} ומכינה כיתוב קצר...`);
    let usedNetwork = false;

    try {
      let detectedPlace = photo.detectedPlace;
      if (!detectedPlace && typeof photo.latitude === "number" && typeof photo.longitude === "number") {
        usedNetwork = true;
        const place = await reverseGeocode(photo.latitude, photo.longitude);
        if (place) {
          detectedPlace = place;
          setPhotos((currentPhotos) => currentPhotos.map((item) => (
            item.id === photo.id ? { ...item, detectedPlace: place } : item
          )));
        }
      }

      if (detectedPlace) {
        updatePhotoCaption(photo.id, `${detectedPlace} · ${formatDate(photo.date)}`, "auto");
        setStatus(`המיקום זוהה מנתוני ה-GPS שבתמונה: ${detectedPlace}.`);
        return usedNetwork;
      }

      if (placeHint.trim()) {
        updatePhotoCaption(photo.id, `${placeHint.trim()} · ${formatDate(photo.date)}`, "auto");
        setStatus("לא נמצאו נתוני GPS בתמונה, לכן השתמשתי ברמז המקום שהזנת.");
        return usedNetwork;
      }

      setStatus("בתמונה הזו אין נתוני מיקום (GPS). אפשר לכתוב רמז מקום בהגדרות ולנסות שוב, או לכתוב כיתוב ידני.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`זיהוי מקום נכשל עבור ${photo.name}: ${message}`);
      setStatus(`לא הצלחתי לזהות את המיקום: ${message}`);
    } finally {
      setAnalyzingCaptions((items) => ({ ...items, [photo.id]: false }));
    }
    return usedNetwork;
  }

  async function fillAllCaptions() {
    const targets = albumPhotos.filter((photo) => !photoCaptions[photo.id]?.trim());
    if (!targets.length) {
      setStatus("לכל התמונות כבר יש כיתוב.");
      return;
    }

    rememberUndo("זיהוי כיתובים");
    setStatus(`מזהה מקום ל-${targets.length} תמונות. זה לוקח בערך שנייה לכל תמונה עם GPS.`);
    for (const photo of targets) {
      const usedNetwork = await identifyPhotoCaption(photo, false);
      // The free place-name service allows about one request per second.
      if (usedNetwork) await wait(1100);
    }
    setStatus("הזיהוי הסתיים. תמונות בלי GPS ובלי רמז מקום נשארו בלי כיתוב.");
  }

  function clearPhotoCaption(photoId: string) {
    rememberUndo("מחיקת כיתוב");
    setPhotoCaptions((captions) => ({
      ...captions,
      [photoId]: "",
    }));
    setCaptionSource(photoId);
  }

  function isAutomaticCaption(photo: Photo, caption: string) {
    const trimmedCaption = caption.trim();
    if (!trimmedCaption) return false;
    if (captionSources[photo.id] === "auto") return true;
    if (trimmedCaption === suggestedCaption(photo)) return true;
    return isLegacyGenericCaption(trimmedCaption);
  }

  function clearAutomaticCaptions() {
    rememberUndo("מחיקת כיתובים אוטומטיים");
    let clearedCount = 0;

    setPhotoCaptions((captions) => {
      const nextCaptions = { ...captions };
      albumPhotos.forEach((photo) => {
        const caption = nextCaptions[photo.id] || "";
        if (isAutomaticCaption(photo, caption)) {
          nextCaptions[photo.id] = "";
          clearedCount += 1;
        }
      });
      return nextCaptions;
    });

    setCaptionSources((sources) => {
      const nextSources = { ...sources };
      albumPhotos.forEach((photo) => {
        if (sources[photo.id] === "auto") delete nextSources[photo.id];
      });
      return nextSources;
    });

    setStatus(clearedCount
      ? `נמחקו ${clearedCount} כיתובים אוטומטיים. כיתובים שערכת ידנית נשארו.`
      : "לא נמצאו כיתובים אוטומטיים למחיקה.");
  }

  function updatePageDecoration(pageKey: string, value: PageDecoration) {
    rememberUndo("שינוי איור");
    setPageDecorations((decorations) => ({
      ...decorations,
      [pageKey]: value,
    }));
  }

  function deletePhoto(photo: Photo) {
    const shouldDelete = window.confirm("למחוק את התמונה הזו מהאלבום?");
    if (!shouldDelete) return;

    rememberUndo("מחיקת תמונה");
    // If this photo opened a page, hand that page's title, text, layout and decoration to the next photo.
    const photoIndex = photos.findIndex((item) => item.id === photo.id);
    const nextPhotoId = photos[photoIndex + 1]?.id;
    const handOver = <T,>(map: Record<string, T>) => {
      if (!(photo.id in map)) return map;
      const next = { ...map };
      if (nextPhotoId && !(nextPhotoId in next)) next[nextPhotoId] = map[photo.id];
      delete next[photo.id];
      return next;
    };
    setPageContent(handOver);
    setPageLayouts(handOver);
    setPageDecorations(handOver);
    setPhotos((currentPhotos) => currentPhotos.filter((item) => item.id !== photo.id));
    setPhotoCaptions((captions) => {
      const nextCaptions = { ...captions };
      delete nextCaptions[photo.id];
      return nextCaptions;
    });
    setCaptionSources((sources) => {
      const nextSources = { ...sources };
      delete nextSources[photo.id];
      return nextSources;
    });
    setAnalyzingCaptions((items) => {
      const nextItems = { ...items };
      delete nextItems[photo.id];
      return nextItems;
    });
    if (coverPhotoId === photo.id) setCoverPhotoId("none");
    setStatus("התמונה נמחקה מהאלבום. שאר התמונות נשארו בסדר הנוכחי.");
  }

  async function handleLibraryFiles(event: ChangeEvent<HTMLInputElement>) {
    const chosenFiles = Array.from(event.target.files || []);
    event.target.value = "";
    const libraryName = newLibraryName.trim();

    if (!libraryName) {
      setStatus("כתבי קודם שם לאלבום במאגר, למשל מדגסקר.");
      return;
    }
    if (!chosenFiles.length) return;

    setIsSavingLibrary(true);
    setIsLoading(true);
    setStatus(`מכינה את אלבום „${libraryName}” ושומרת את התמונות במאגר...`);

    try {
      const imageFiles = chosenFiles.filter(isSupportedImageFile);
      const zipFiles = chosenFiles.filter((file) => /\.zip$/i.test(file.name) || file.type.includes("zip"));
      for (const zipFile of zipFiles) {
        imageFiles.push(...await extractImagesFromZip(zipFile));
      }

      const uniqueFiles: File[] = [];
      const signatures = new Set<string>();
      imageFiles.forEach((file) => {
        const signature = fileSignature(file);
        if (!signatures.has(signature)) {
          signatures.add(signature);
          uniqueFiles.push(file);
        }
      });

      if (!uniqueFiles.length) {
        setStatus("לא נמצאו בקבצים תמונות נתמכות.");
        return;
      }

      setUploadProgress(0);
      setUploadTotal(uniqueFiles.length);
      const storedPhotos: StoredPhoto[] = [];
      const failedNames: string[] = [];
      const createdAt = new Date().toISOString();

      for (let index = 0; index < uniqueFiles.length; index += 1) {
        const file = uniqueFiles[index];
        try {
          const [displayBlob, metadata] = await Promise.all([
            fileToDisplayBlob(file),
            readPhotoMetadata(file),
          ]);
          const previewUrl = URL.createObjectURL(displayBlob);
          const imageDetails = await readImageDetails(previewUrl);
          URL.revokeObjectURL(previewUrl);
          storedPhotos.push({
            id: `library-${Date.now()}-${index}-${file.name}`,
            name: file.name,
            blob: displayBlob,
            signature: fileSignature(file),
            date: photoDateFrom(file, metadata).toISOString(),
            ...imageDetails,
            ...gpsFrom(metadata),
          });
        } catch {
          failedNames.push(file.name);
        }
        setUploadProgress(index + 1);
      }

      if (!storedPhotos.length) {
        setStatus("לא הצלחתי לשמור את התמונות במאגר. נסי תחילה עם תמונה אחת.");
        return;
      }

      const library: PhotoLibrary = {
        id: `library-${Date.now()}`,
        name: libraryName,
        createdAt,
        photos: storedPhotos,
      };
      await writePhotoLibrary(library);
      setPhotoLibraries((libraries) => [library, ...libraries]);
      setActiveLibraryId(library.id);
      setNewLibraryName("");
      setStatus(`האלבום „${libraryName}” נשמר במאגר עם ${storedPhotos.length} תמונות${failedNames.length ? `. ${failedNames.length} קבצים לא נשמרו` : ""}. עכשיו אפשר לבחור ממנו תמונות לספר.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`שמירת מאגר נכשלה: ${message}`);
      setStatus("לא הצלחתי לשמור את האלבום במאגר. ייתכן שאין מספיק מקום פנוי בדפדפן.");
    } finally {
      setIsSavingLibrary(false);
      setIsLoading(false);
      setUploadProgress(0);
      setUploadTotal(0);
    }
  }

  function toggleLibraryPhoto(id: string) {
    setSelectedLibraryPhotoIds((selected) => {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllLibraryPhotos() {
    if (!activePhotoLibrary) return;
    setSelectedLibraryPhotoIds((selected) => (
      selected.size === activePhotoLibrary.photos.length
        ? new Set()
        : new Set(activePhotoLibrary.photos.map((photo) => photo.id))
    ));
  }

  function addSelectedLibraryPhotos() {
    if (!activePhotoLibrary || !selectedLibraryPhotoIds.size) {
      setStatus("סמני לפחות תמונה אחת מהמאגר.");
      return;
    }

    const existingSignatures = new Set(photos.map((photo) => photo.signature).filter(Boolean));
    const selectedStoredPhotos = activePhotoLibrary.photos.filter((photo) => selectedLibraryPhotoIds.has(photo.id));
    const addedPhotos = selectedStoredPhotos
      .filter((photo) => !photo.signature || !existingSignatures.has(photo.signature))
      .map((photo, index) => ({
        ...photo,
        id: `book-${Date.now()}-${index}-${photo.id}`,
        url: URL.createObjectURL(photo.blob),
        date: new Date(photo.date),
      } as Photo));
    const duplicateCount = selectedStoredPhotos.length - addedPhotos.length;

    if (!addedPhotos.length) {
      setStatus("כל התמונות שסימנת כבר נמצאות בספר.");
      return;
    }

    rememberUndo("הוספה ממאגר התמונות");
    setPhotos((currentPhotos) => [...currentPhotos, ...sortPhotosByDate(addedPhotos)]);
    setSelectedLibraryPhotoIds(new Set());
    setCurrentSpread(1);
    setStatus(`נוספו ${addedPhotos.length} תמונות מהאלבום „${activePhotoLibrary.name}” לספר${duplicateCount ? `. ${duplicateCount} כפולות לא נוספו` : ""}.`);
  }

  async function deleteActivePhotoLibrary() {
    if (!activePhotoLibrary) return;
    if (!window.confirm(`למחוק את אלבום „${activePhotoLibrary.name}” מהמאגר? התמונות שכבר נוספו לספר לא יימחקו.`)) return;

    try {
      await removePhotoLibrary(activePhotoLibrary.id);
      const remaining = photoLibraries.filter((library) => library.id !== activePhotoLibrary.id);
      setPhotoLibraries(remaining);
      setActiveLibraryId(remaining[0]?.id || "");
      setStatus(`האלבום „${activePhotoLibrary.name}” נמחק מהמאגר. תמונות שכבר נמצאות בספר נשארו.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`מחיקת מאגר נכשלה: ${message}`);
      setStatus("לא הצלחתי למחוק את האלבום מהמאגר.");
    }
  }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    addDebug(`נבחרו ${files.length} קבצים`);

    if (!files.length) {
      setStatus("לא נבחרו קבצים.");
      return;
    }

    const zipFiles = files.filter((file) => /\.zip$/i.test(file.name) || file.type.includes("zip"));
    const imageFiles = files.filter(isSupportedImageFile);

    if (zipFiles.length) {
      setIsLoading(true);
      setStatus(`פותחת ${zipFiles.length === 1 ? "את קובץ ה־ZIP" : `${zipFiles.length} קובצי ZIP`} ומאתרת תמונות...`);
      try {
        for (const zipFile of zipFiles) {
          const extracted = await extractImagesFromZip(zipFile);
          imageFiles.push(...extracted);
          addDebug(`נמצאו ${extracted.length} תמונות בתוך ${zipFile.name}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
        addDebug(`שגיאה בפתיחת ZIP: ${message}`);
        setIsLoading(false);
        setStatus("לא הצלחתי לפתוח את קובץ ה־ZIP. נסי להוריד אותו שוב מ־iCloud.");
        event.target.value = "";
        return;
      }
    }

    if (!imageFiles.length) {
      setIsLoading(false);
      setStatus(zipFiles.length ? "קובץ ה־ZIP נפתח, אבל לא נמצאו בו תמונות נתמכות." : "הקבצים שנבחרו לא זוהו כתמונות.");
      event.target.value = "";
      return;
    }

    const beforeUploadSnapshot = createUndoSnapshot();
    const existingSignatures = new Set(photos.map((photo) => photo.signature).filter(Boolean));
    const existingDateSignatures = new Set(
      photos.map((photo) => `${photo.name.toLowerCase()}::${photo.date.getTime() || 0}`),
    );
    const seenInSelection = new Set<string>();
    const seenDatesInSelection = new Set<string>();
    const uniqueImageFiles: File[] = [];
    const duplicateNames: string[] = [];

    imageFiles.forEach((file) => {
      const signature = fileSignature(file);
      const dateSignature = fileDateSignature(file);
      if (
        existingSignatures.has(signature) ||
        existingDateSignatures.has(dateSignature) ||
        seenInSelection.has(signature) ||
        seenDatesInSelection.has(dateSignature)
      ) {
        duplicateNames.push(file.name);
        return;
      }
      seenInSelection.add(signature);
      seenDatesInSelection.add(dateSignature);
      uniqueImageFiles.push(file);
    });

    if (!uniqueImageFiles.length) {
      setStatus(`כל ${imageFiles.length} התמונות שנבחרו כבר קיימות באלבום, אז לא הוספתי עותקים כפולים.`);
      event.target.value = "";
      return;
    }

    setIsLoading(true);
    setUploadProgress(0);
    setUploadTotal(uniqueImageFiles.length);
    setStatus(`טוענת ${uniqueImageFiles.length} תמונות. תמונות HEIC של אייפון יומרו אוטומטית ל-JPG.`);

    const addedPhotos: Photo[] = [];
    const failures: string[] = [];
    let convertedCount = 0;
    const startedAt = Date.now();

    const processFile = async (file: File, index: number) => {
      try {
        const [displayBlob, metadata] = await Promise.all([fileToDisplayBlob(file), readPhotoMetadata(file)]);
        const wasConverted = displayBlob !== file;
        const url = URL.createObjectURL(displayBlob);
        const imageDetails = await readImageDetails(url);
        const id = `${file.name}-${file.lastModified}-${file.size}-${index}-${startedAt}`;
        return {
          photo: {
            id,
            name: file.name,
            url,
            signature: fileSignature(file),
            date: photoDateFrom(file, metadata),
            ...gpsFrom(metadata),
            ...imageDetails,
          } as Photo,
          wasConverted,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
        addDebug(`שגיאה ב-${file.name}: ${message}`);
        return { failedName: file.name };
      }
    };

    const batchSize = IS_IOS ? 1 : 3;
    for (let batchStart = 0; batchStart < uniqueImageFiles.length; batchStart += batchSize) {
      const batch = uniqueImageFiles.slice(batchStart, batchStart + batchSize);
      const results = await Promise.all(batch.map((file, offset) => processFile(file, batchStart + offset)));
      results.forEach((result) => {
        if ("photo" in result && result.photo) {
          addedPhotos.push(result.photo);
          if (result.wasConverted) convertedCount += 1;
        } else if (result.failedName) {
          failures.push(result.failedName);
        }
      });
      const completed = Math.min(batchStart + batch.length, uniqueImageFiles.length);
      setUploadProgress(completed);
      setStatus(`עובדו ${completed} מתוך ${uniqueImageFiles.length} תמונות...`);
    }

    if (addedPhotos.length) {
      setUndoSnapshot(beforeUploadSnapshot);
      setUndoLabel("העלאת תמונות");
      setRedoSnapshot(null);
      setRedoLabel("");
      setPhotos((currentPhotos) => [...currentPhotos, ...sortPhotosByDate(addedPhotos)]);
      setCurrentSpread(1);
      if (window.matchMedia("(max-width: 880px)").matches) {
        window.setTimeout(() => {
          document.getElementById("album-preview")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 120);
      }
    }
    setIsLoading(false);
    event.target.value = "";

    if (addedPhotos.length && failures.length) {
      setStatus(`נוספו ${addedPhotos.length} תמונות לסוף האלבום לפי תאריך. ${failures.length} קבצים לא נטענו. ${duplicateNames.length} כפולות לא נוספו. הומרו ${convertedCount} תמונות אייפון.`);
      return;
    }

    if (addedPhotos.length) {
      setStatus(`נוספו ${addedPhotos.length} תמונות לסוף האלבום לפי תאריך. ${duplicateNames.length ? `${duplicateNames.length} תמונות כפולות לא נוספו. ` : ""}הומרו ${convertedCount} תמונות אייפון.`);
      return;
    }

    setStatus("לא הצלחתי להציג את התמונות שנבחרו. נסי לבחור תמונה אחת לבדיקה או לשלוח לי צילום של האבחון.");
  }

  async function handleCoverFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      setStatus("לא נבחרה תמונת כריכה.");
      return;
    }

    const name = file.name.toLowerCase();
    if (!file.type.startsWith("image/") && !/\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(name)) {
      setStatus("הקובץ שנבחר לכריכה לא זוהה כתמונה.");
      event.target.value = "";
      return;
    }

    setIsLoading(true);
    setStatus("טוענת תמונת כריכה. אם זו תמונת אייפון, היא תומר אוטומטית ל-JPG.");

    try {
      const displayBlob = await fileToDisplayBlob(file);
      rememberUndo("החלפת כריכה");
      setCustomCover({
        id: `cover-${file.name}-${file.lastModified}-${Date.now()}`,
        name: file.name,
        url: URL.createObjectURL(displayBlob),
      });
      setCoverPhotoId("custom");
      setStatus("תמונת הכריכה נטענה.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "שגיאה לא ידועה";
      addDebug(`שגיאה בתמונת כריכה ${file.name}: ${message}`);
      setStatus("לא הצלחתי להציג את תמונת הכריכה. נסי לבחור תמונה אחרת.");
    } finally {
      setIsLoading(false);
      event.target.value = "";
    }
  }

  function addDemoPhoto() {
    rememberUndo("תמונת בדיקה");
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
        <rect width="1200" height="900" fill="#fff3e0"/>
        <circle cx="360" cy="330" r="150" fill="#8e4f3a" opacity=".9"/>
        <circle cx="725" cy="405" r="210" fill="#d6a849" opacity=".82"/>
        <rect x="230" y="610" width="740" height="60" rx="30" fill="#633421" opacity=".75"/>
        <text x="600" y="710" text-anchor="middle" font-family="Arial" font-size="54" font-weight="700" fill="#633421">תמונת בדיקה</text>
      </svg>
    `;
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    setPhotos([
      {
        id: `demo-${Date.now()}`,
        name: "תמונת בדיקה",
        url,
        date: new Date(),
        width: 1200,
        height: 900,
        brightness: "bright",
      },
    ]);
    setStatus("תמונת בדיקה נטענה. אם זה עובד, האתר עצמו תקין.");
  }

  function clearPhotos() {
    rememberUndo("ניקוי תמונות");
    if (coverPhotoId !== "custom") setCoverPhotoId("none");
    setPhotos([]);
    setPageContent({});
    setPageLayouts({});
    setPhotoCaptions({});
    setCaptionSources({});
    setStatus("התמונות נוקו. אפשר לבחור שוב.");
  }

  function clearCover() {
    rememberUndo("ניקוי כריכה");
    setCustomCover(null);
    setCoverPhotoId("none");
    setStatus("תמונת הכריכה נוקתה.");
  }

  function renderPhotoPicker(photo: Photo) {
    return (
      <input className="photo-position-picker" type="file" accept={PHOTO_ACCEPT}
        aria-label={`בחרי תמונה למיקום הזה במקום ${photo.name}`}
        title="בחרי תמונה למיקום הזה"
        disabled={isLoading}
        onChange={(event) => replacePhoto(event, photo)} />
    );
  }

  function renderPrintablePage(page: PrintablePage, isVisible: boolean) {
    const visibilityClass = isVisible ? "is-visible" : "is-hidden";

    if (page.type === "cover") {
      return (
        <article className={`book-page ${visibilityClass} sheet cover-sheet ${coverImage ? "has-cover-image" : ""}`} key="cover">
          {coverImage && <img className="cover-image" src={coverImage.url} alt={coverImage.name} />}
          <div className="cover-frame">
            <div className={`cover-date${coverDateText.trim() || albumPhotos.length ? "" : " cover-text-empty"}`}>
              <CoverText label="עריכת תאריך בכריכה" text={coverDate}
                onEdit={() => editCoverText("תאריך או טקסט עליון", coverDateText, setCoverDateText, dateRange)} />
            </div>
            <h2 className={title ? "" : "cover-text-empty"}>
              <CoverText label="עריכת שם האלבום בכריכה" text={title || "שם האלבום"}
                onEdit={() => editCoverText("שם האלבום", title, setTitle)} />
            </h2>
            <p className={`cover-subtitle${subtitle ? "" : " cover-text-empty"}`}>
              <CoverText label="עריכת כותרת משנה בכריכה" text={subtitle || "הוספת כותרת משנה"}
                onEdit={() => editCoverText("כותרת משנה", subtitle, setSubtitle)} />
            </p>
            <p className={`cover-note${note ? "" : " cover-text-empty"}`}>
              <CoverText label="עריכת מלל חופשי בכריכה" text={note || "הוספת מלל"}
                onEdit={() => editCoverText("מלל חופשי", note, setNote)} />
            </p>
          </div>
        </article>
      );
    }

    if (page.type === "coverBack") {
      return (
        <article className={`book-page ${visibilityClass} sheet cover-back-sheet`} aria-label="גב כריכה ריק" key="cover-back">
          <div>
            <span>גב הכריכה</span>
            <p>עמוד זה נשאר ריק כדי שהכריכה תהיה דף חד-צדדי.</p>
          </div>
        </article>
      );
    }

    if (page.type === "route") {
      const places = routePlaces.map((place) => place.trim()).filter(Boolean);
      const pointCount = Math.max(places.length, 2);
      const points = places.map((place, index) => {
        const progress = pointCount === 1 ? 0 : index / (pointCount - 1);
        const x = index % 2 === 0 ? 35 : 65;
        const y = 12 + progress * 76;
        return { place, x, y };
      });
      const polyline = points.map((point) => `${point.x},${point.y}`).join(" ");

      return (
        <article className={`book-page ${visibilityClass} sheet route-sheet`} key="route-page">
          <header className="route-header">
            <span>מפת מסלול</span>
            <h2>{routeTitle}</h2>
          </header>
          <div className="route-map" aria-label="מסלול הטיול">
            <svg viewBox="0 0 100 100" role="img" aria-hidden="true">
              <path d="M12 18 C28 8 36 24 52 14 S82 12 88 28 C96 50 74 56 82 76 C88 92 54 92 48 78 C38 56 14 76 12 50 C10 36 24 32 12 18Z" />
              {points.length > 1 && <polyline points={polyline} />}
              {points.map((point, index) => (
                <g key={`${point.place}-${index}`}>
                  <circle cx={point.x} cy={point.y} r="2.8" />
                  <text
                    x={point.x + (point.x < 50 ? 4.5 : -4.5)}
                    y={point.y + 1.4}
                    textAnchor={point.x < 50 ? "start" : "end"}
                  >
                    {index + 1}
                  </text>
                </g>
              ))}
            </svg>
            <ol>
              {places.map((place, index) => (
                <li key={`route-item-${index}`}>{place}</li>
              ))}
            </ol>
          </div>
        </article>
      );
    }

    if (page.type === "empty") {
      return (
        <article className={`book-page ${visibilityClass} sheet empty-sheet`} key="empty">
          <div>
            <h2>העלי תמונות כדי להתחיל</h2>
            <p>אם התמונות לא עולות מתוך קובץ מקומי באייפון, האתר הזה פותר את הבעיה כי הוא נפתח כעמוד רגיל ב-Safari.</p>
          </div>
        </article>
      );
    }

    if (page.type === "photoSpreadHalf") {
      const { albumPage, side } = page;
      const photo = albumPage.pagePhotos[0];
      const sideLabel = side === "start" ? "חצי ראשון" : "חצי שני";

      return (
        <article
          className={`book-page ${visibilityClass} sheet photo-spread-half spread-${side}`}
          key={`photo-spread-${albumPage.pageIndex}-${side}`}
        >
          <div className="spread-warning">
            {sideLabel} של תמונה על כפולה. הקו המקווקו מסמן את החיבור באמצע.
          </div>
          <div aria-label={`${photo.name} - ${sideLabel}`} className="spread-photo-panel">
            <img className="spread-photo-image" src={photo.url} alt="" />
            {renderPhotoPicker(photo)}
          </div>
          <div className="spread-gutter-mark" aria-hidden="true" />
        </article>
      );
    }

    const { albumPage } = page;
    const { pagePhotos, pageIndex, pageKey, startIndex, capacity, singlePhotoMode } = albumPage;
    const emptySlotsCount = draggedPhotoId && pagePhotos.length < capacity
      ? capacity - pagePhotos.length
      : 0;
    const photoGridCount = Math.max(1, pagePhotos.length + emptySlotsCount);
    const pageOrientationClass = getPageOrientationClass(pagePhotos);
    const layoutPlan = planPageLayout([
      ...pagePhotos.map(photoRatio),
      ...Array.from({ length: emptySlotsCount }, () => 1),
    ], photoGridCount);
    const renderFigure = (photo: Photo, grow: number) => (
      <figure
        style={{ flexGrow: grow }}
        className={[
          draggedPhotoId === photo.id ? "is-dragging" : "",
          dropTarget?.type === "photo" && dropTarget.id === photo.id ? "is-drop-target" : "",
          `orientation-${getPhotoOrientation(photo)}`,
        ].filter(Boolean).join(" ")}
        draggable
        key={photo.id}
        onDragEnd={() => {
          setDraggedPhotoId("");
          setDropTarget(null);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDropTarget({ type: "photo", id: photo.id });
        }}
        onDragStart={(event) => {
          setDraggedPhotoId(photo.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", photo.id);
        }}
        onDrop={(event) => {
          event.preventDefault();
          finishPhotoDrop({ type: "photo", id: photo.id });
        }}
      >
        <div className="photo-menu">
          <details>
            <summary aria-label={`פעולות לתמונה ${photo.name}`}>⋮</summary>
            <div>
              <button
                type="button"
                onClick={(event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
                  setAdjustingPhotoId(photo.id);
                }}
              >
                גודל וחיתוך
              </button>
              <label className="photo-menu-file">
                החלפת תמונה
                <input
                  type="file"
                  accept={PHOTO_ACCEPT}
                  onChange={(event) => replacePhoto(event, photo)}
                  disabled={isLoading}
                />
              </label>
              <button type="button" onClick={() => setStatus("לחצי לחיצה ארוכה וגררי את התמונה לתמונה אחרת כדי להחליף מיקום.")}>
                שינוי סדר בגרירה
              </button>
              <label className="photo-menu-page">
                העברה לעמוד
                <select
                  defaultValue=""
                  onChange={(event) => {
                    const pageNumber = Number(event.target.value);
                    if (pageNumber) movePhotoToPage(photo, pageNumber);
                    event.target.value = "";
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  <option value="" disabled>בחרי עמוד</option>
                  {pages.map((albumPage) => (
                    <option value={albumPage.pageIndex + 1} key={albumPage.pageIndex}>
                      עמוד {albumPage.pageIndex + 1}
                    </option>
                  ))}
                </select>
              </label>
              <button
              type="button"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                identifyPhotoCaption(photo);
              }}
              disabled={analyzingCaptions[photo.id]}
            >
              {analyzingCaptions[photo.id] ? "מזהה מקום..." : "זיהוי מקום לכיתוב"}
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                clearPhotoCaption(photo.id);
              }}
            >
              מחיקת כיתוב
            </button>
            <button type="button" onClick={() => duplicatePhoto(photo)}>
                שכפל תמונה
              </button>
              <button className="danger-action" type="button" onClick={() => deletePhoto(photo)}>
                מחק תמונה
              </button>
            </div>
          </details>
        </div>
        <div
          className="photo-frame adj-frame"
          data-photo-id={photo.id}
          style={photoAdjustStyle(photo)}
        >
          <div className="adj-box">
            <img
              src={photo.url}
              alt={photo.name}
              draggable={false}
              onLoad={(event) => event.currentTarget.closest("figure")?.classList.remove("image-error")}
              onError={(event) => {
                event.currentTarget.closest("figure")?.classList.add("image-error");
              }}
            />
          </div>
          <span className="photo-repick">לא ניתן להציג את התמונה. לחצי לבחירת תמונה אחרת.</span>
          {renderPhotoPicker(photo)}
        </div>
        <figcaption>
          {showPhotoDates && (
            <time className="photo-date" dateTime={photo.date.toISOString()}>{formatDate(photo.date)}</time>
          )}
          <textarea
            aria-label={`כיתוב לתמונה ${photo.name}`}
            className="inline-edit caption-edit"
            rows={pagePhotos.length >= 4 ? 2 : 3}
            value={photoCaptions[photo.id] ?? ""}
            onFocus={() => rememberFieldEdit("עריכת כיתוב תמונה")}
            onChange={(event) => updatePhotoCaption(photo.id, event.target.value)}
            placeholder="כיתוב / הסבר קצר לתמונה"
          />
          {captionSources[photo.id] === "auto" && photoCaptions[photo.id]?.trim() && (
            <small className="auto-caption-note">כיתוב אוטומטי</small>
          )}
          </figcaption>
      </figure>
    );
    const renderDropSlot = (emptySlotIndex: number, grow: number) => {
      const targetIndex = startIndex + pagePhotos.length + emptySlotIndex;
      return (
      <div
        style={{ flexGrow: grow }}
        className={`photo-drop-slot ${dropTarget?.type === "empty" && dropTarget.index === targetIndex ? "is-drop-target" : ""}`}
        key={`empty-${pageIndex}-${emptySlotIndex}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDropTarget({ type: "empty", index: targetIndex });
        }}
        onDrop={(event) => {
          event.preventDefault();
          finishPhotoDrop({ type: "empty", index: targetIndex });
        }}
      >
        שחררי כאן
      </div>
      );
    };

    return (
      <article className={`book-page ${visibilityClass} sheet photo-sheet photos-${photoGridCount}`} key={`photo-page-${pageIndex}`}>
        <header className="page-header">
          <input
            aria-label={`כותרת עמוד ${pageIndex + 1}`}
            className="inline-edit page-title-edit"
            value={pageContent[pageKey]?.title ?? ""}
            onFocus={() => rememberFieldEdit("עריכת כותרת עמוד")}
            onChange={(event) => updatePageContent(pageKey, "title", event.target.value)}
            placeholder="כותרת לעמוד, לא יודפס אם ריק"
          />
          <label className="page-decoration-control">
            איור
            <select
              value={pageDecorations[pageKey] || "none"}
              onChange={(event) => updatePageDecoration(pageKey, event.target.value as PageDecoration)}
            >
              <option value="none">בלי</option>
              <option value="sparkles">כוכבים</option>
              <option value="hearts">לב</option>
              <option value="flowers">פרחוני</option>
              <option value="sun">שמש</option>
              <option value="anchor">ים</option>
              <option value="camera">מצלמה</option>
              <option value="plane">מטוס / טיול</option>
              <option value="location">סימון מקום</option>
              <option value="waves">גלים</option>
            </select>
          </label>
          <label className="page-layout-control">
            תמונות
            <select
              value={capacity}
              onChange={(event) => changePagePhotoCount(pageKey, pageIndex + 1, Number(event.target.value))}
            >
              {PHOTO_COUNT_OPTIONS.map((count) => (
                <option value={count} key={count}>{count}</option>
              ))}
            </select>
          </label>
          <input
            aria-label={`תאריך עמוד ${pageIndex + 1}`}
            className="inline-edit page-date-edit"
            value={pageContent[pageKey]?.date ?? formatDate(pagePhotos[0].date)}
            onFocus={() => rememberFieldEdit("עריכת תאריך עמוד")}
            onChange={(event) => updatePageContent(pageKey, "date", event.target.value)}
          />
        </header>
        <textarea
          aria-label={`מלל חופשי בעמוד ${pageIndex + 1}`}
          className="inline-edit page-note-edit"
          rows={pagePhotos.length === 4 ? 1 : 2}
          value={pageContent[pageKey]?.text ?? ""}
          onFocus={() => rememberFieldEdit("עריכת מלל עמוד")}
          onChange={(event) => updatePageContent(pageKey, "text", event.target.value)}
          placeholder="אפשר להוסיף כאן מלל לעמוד"
        />
        {capacity === 1 && pagePhotos.length === 1 && (
          <div className="single-photo-controls">
            <span>תמונה אחת:</span>
            <button
              className={singlePhotoMode === "page" ? "is-active" : ""}
              type="button"
              onClick={() => changeSinglePhotoMode(pageKey, "page")}
            >
              עמוד מלא
            </button>
            <button
              className={singlePhotoMode === "spread" ? "is-active" : ""}
              type="button"
              onClick={() => changeSinglePhotoMode(pageKey, "spread")}
            >
              כפולה פתוחה
            </button>
            {singlePhotoMode === "spread" && (
              <small>שימי לב: אזור החיבור באמצע עלול לעבור על פנים או פרט חשוב.</small>
            )}
          </div>
        )}
        {(pageDecorations[pageKey] || "none") !== "none" && (
          <div className="page-decoration" aria-hidden="true">
            {DECORATION_LABELS[pageDecorations[pageKey] || "none"]}
          </div>
        )}
        <div className={`photo-grid smart-layout count-${photoGridCount} ${pageOrientationClass} layout-${layoutPlan.mode}`}>
          {layoutPlan.lines.map((line, lineIndex) => (
            <div className="photo-line" key={`line-${lineIndex}`} style={{ flexGrow: line.grow }}>
              {line.items.map((item) => (
                item.index < pagePhotos.length
                  ? renderFigure(pagePhotos[item.index], item.grow)
                  : renderDropSlot(item.index - pagePhotos.length, item.grow)
              ))}
            </div>
          ))}
        </div>
      </article>
    );
  }

  return (
    <main className={`app-shell font-${albumFont}`} dir="rtl">
      {adjustingPhoto && (
        <PhotoAdjustDialog
          key={adjustingPhoto.id}
          photo={adjustingPhoto}
          onClose={() => setAdjustingPhotoId("")}
          onSave={(zoom, crop) => {
            savePhotoAdjust(adjustingPhoto.id, zoom, crop);
            setAdjustingPhotoId("");
          }}
        />
      )}
      {showDuplicates && (
        <div className="duplicate-overlay" role="dialog" aria-modal="true" aria-labelledby="duplicate-title">
          <div className="duplicate-panel">
            <header>
              <h2 id="duplicate-title">תמונות כפולות ודומות</h2>
              <p>
                בכל קבוצה סימנתי ⭐ את התמונה החדה והאיכותית ביותר. תמונות עם מסגרת אדומה יוסרו מהאלבום.
                לחיצה על תמונה מחליפה בין &quot;נשארת&quot; ל&quot;תוסר&quot;.
              </p>
            </header>
            <div className="duplicate-groups">
              {duplicateGroups.length === 0 && <p className="hint">לא נשארו תמונות כפולות לבדיקה.</p>}
              {duplicateGroups.map((group) => {
                const best = bestPhotoOf(group);
                return (
                  <section className="duplicate-group" key={group.map((photo) => photo.id).join("|")}>
                    <div className="duplicate-group-head">
                      <strong>{group.length} תמונות דומות</strong>
                      <button type="button" onClick={() => keepDuplicateGroup(group)}>להשאיר את כולן</button>
                    </div>
                    <div className="duplicate-photos">
                      {group.map((photo) => {
                        const removing = duplicateRemovals.has(photo.id);
                        return (
                          <button
                            className={`duplicate-photo ${removing ? "is-removing" : "is-keeping"}`}
                            type="button"
                            key={photo.id}
                            aria-pressed={!removing}
                            aria-label={`${photo.name}: ${removing ? "תוסר" : "נשארת"}`}
                            onClick={() => toggleDuplicateRemoval(photo.id)}
                          >
                            <img src={photo.url} alt="" />
                            {photo.id === best.id && <span className="duplicate-best">⭐ הכי טובה</span>}
                            <span className="duplicate-state">{removing ? "תוסר" : "נשארת"}</span>
                            <small>{formatDate(photo.date)} · {photo.width && photo.height ? `${photo.width}×${photo.height}` : ""}</small>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
            <footer>
              <button className="primary" type="button" onClick={removeChosenDuplicates} disabled={!duplicateRemovals.size}>
                הסרת {duplicateRemovals.size} {duplicateRemovals.size === 1 ? "תמונה" : "תמונות"} מהאלבום
              </button>
              <button type="button" onClick={() => setShowDuplicates(false)}>סגירה</button>
            </footer>
          </div>
        </div>
      )}
      <dialog ref={coverDialog} className="cover-editor" aria-labelledby="cover-editor-label" onClose={() => setCoverEdit(null)}>
        {coverEdit && (
          <form onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get("cover-text") ?? "");
            if (value !== coverEdit.value) {
              rememberFieldEdit("עריכת טקסט בכריכה");
              coverEdit.save(value);
            }
            coverDialog.current?.close();
          }}>
            <label htmlFor="cover-editor-text" id="cover-editor-label">{coverEdit.label}</label>
            <textarea id="cover-editor-text" name="cover-text" rows={coverEdit.label === "מלל חופשי" ? 3 : 2}
              defaultValue={coverEdit.value} placeholder={coverEdit.automatic} autoFocus />
            <div className="cover-editor-actions">
              <button type="submit">שמירה</button>
              <button type="button" onClick={() => coverDialog.current?.close()}>ביטול</button>
            </div>
          </form>
        )}
      </dialog>
      <aside className="controls">
        <section>
          <span className="eyebrow">A4 Photo Book</span>
          <h1>אלבום תמונות להדפסה</h1>
          <p className="intro">בחרי תמונות, סדרי כמות בעמוד, ואז שמרי כ-PDF מחלון ההדפסה.</p>
        </section>

        <section className="upload-box simple-upload">
          <span className="step-label">שלב 1</span>
          <h2>הוספת תמונות</h2>
          <p className="hint">באייפון ייפתחו התמונות שלך, כולל תמונות שנמצאות ב־iCloud.</p>
          <label className="upload-primary">
            {isLoading ? "טוענת תמונות..." : "בחירת תמונות"}
            <input className="file-input" type="file" accept={PHOTO_ACCEPT} multiple onChange={handleFiles} disabled={isLoading || !hasCheckedSavedAlbum} />
          </label>
          {isLoading && uploadTotal > 0 && (
            <div className="upload-progress" aria-live="polite">
              <progress value={uploadProgress} max={uploadTotal} />
              <span>{uploadProgress} מתוך {uploadTotal}</span>
            </div>
          )}
          <details className="more-import-options">
            <summary>אפשרויות נוספות: תיקייה או ZIP</summary>
            <div>
              <label className="upload-secondary">
                בחירת תיקייה שלמה
                <input
                  className="file-input"
                  type="file"
                  accept={PHOTO_ACCEPT}
                  multiple
                  {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                  onChange={handleFiles}
                  disabled={isLoading || !hasCheckedSavedAlbum}
                />
              </label>
              <label className="upload-secondary">
                בחירת ZIP מ־iCloud
                <input className="file-input" type="file" accept=".zip,application/zip,application/x-zip-compressed" onChange={handleFiles} disabled={isLoading || !hasCheckedSavedAlbum} />
              </label>
              <a className="icloud-web-link" href="https://www.icloud.com/photos/" target="_blank" rel="noreferrer">
                הורדת תמונות מ־iCloud במחשב
              </a>
              <p className="hint">אפשר לבחור את קובץ ה־ZIP כמו שהוא. אין צורך לחלץ אותו.</p>
            </div>
          </details>
          <button className="demo-button" type="button" onClick={addDemoPhoto} disabled={!hasCheckedSavedAlbum}>רוצה לראות דוגמה לפני שמתחילים?</button>
          <p className="hint">{dateRange}</p>
          <p className="status-message" aria-live="polite">{status}</p>
          {duplicateGroups.length > 0 && (
            <button className="duplicate-alert" type="button" onClick={openDuplicateReview}>
              נמצאו {duplicateGroups.length === 1 ? "קבוצה אחת" : `${duplicateGroups.length} קבוצות`} של תמונות כפולות או דומות
              <span>לבחירת הטובה מכל קבוצה ←</span>
            </button>
          )}
          {debug.length > 0 && (
            <details className="debug-details">
              <summary>פרטי תקלה</summary>
              <pre className="debug-log">{debug.join("\n")}</pre>
            </details>
          )}
        </section>

        <section className="photo-library-card" aria-labelledby="photo-library-title">
          <div className="photo-library-heading">
            <div>
              <span className="step-label">חדש</span>
              <h2 id="photo-library-title">מאגר התמונות שלי</h2>
            </div>
            <span className="library-count">{photoLibraries.length} אלבומים</span>
          </div>
          <p className="hint">מעלים אלבום פעם אחת, ובכל ספר בוחרים ממנו רק את התמונות שרוצים. המאגר נשמר במכשיר הזה.</p>

          <details className="library-create" open={!photoLibraries.length}>
            <summary>יצירת אלבום חדש במאגר</summary>
            <div>
              <label className="field">
                שם האלבום
                <input
                  value={newLibraryName}
                  onChange={(event) => setNewLibraryName(event.target.value)}
                  placeholder="לדוגמה: מדגסקר"
                  disabled={isSavingLibrary}
                />
              </label>
              <label className="upload-secondary">
                {isSavingLibrary ? "שומרת במאגר..." : "בחירת תמונות לאלבום"}
                <input className="file-input" type="file" accept={PHOTO_ACCEPT} multiple onChange={handleLibraryFiles} disabled={isLoading || !newLibraryName.trim()} />
              </label>
              <div className="library-import-row">
                <label className="file-action">
                  תיקייה שלמה
                  <input
                    type="file"
                    accept={PHOTO_ACCEPT}
                    multiple
                    {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                    onChange={handleLibraryFiles}
                    disabled={isLoading || !newLibraryName.trim()}
                  />
                </label>
                <label className="file-action">
                  קובץ ZIP
                  <input type="file" accept=".zip,application/zip" onChange={handleLibraryFiles} disabled={isLoading || !newLibraryName.trim()} />
                </label>
              </div>
              {!newLibraryName.trim() && <p className="hint">אחרי שתכתבי שם לאלבום, כפתורי ההעלאה ייפתחו.</p>}
            </div>
          </details>

          {photoLibraries.length > 0 && (
            <div className="library-browser">
              <label className="field">
                בחירת אלבום מהמאגר
                <select value={activeLibraryId} onChange={(event) => setActiveLibraryId(event.target.value)}>
                  {photoLibraries.map((library) => (
                    <option key={library.id} value={library.id}>{library.name} · {library.photos.length} תמונות</option>
                  ))}
                </select>
              </label>

              {activePhotoLibrary && (
                <>
                  <div className="library-toolbar">
                    <button type="button" onClick={toggleAllLibraryPhotos}>
                      {selectedLibraryPhotoIds.size === activePhotoLibrary.photos.length ? "ביטול הכול" : "בחירת הכול"}
                    </button>
                    <button className="library-delete" type="button" onClick={deleteActivePhotoLibrary}>מחיקת האלבום מהמאגר</button>
                  </div>
                  <div className="library-photo-grid" aria-label={`תמונות מהאלבום ${activePhotoLibrary.name}`}>
                    {activePhotoLibrary.photos.map((photo) => {
                      const selected = selectedLibraryPhotoIds.has(photo.id);
                      return (
                        <button
                          className={`library-photo${selected ? " selected" : ""}`}
                          type="button"
                          key={photo.id}
                          aria-pressed={selected}
                          onClick={() => toggleLibraryPhoto(photo.id)}
                        >
                          <img src={libraryPreviewUrls[photo.id]} alt={photo.name} />
                          <span>{selected ? "✓ נבחרה" : formatDate(new Date(photo.date))}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button className="library-add-button" type="button" onClick={addSelectedLibraryPhotos} disabled={!selectedLibraryPhotoIds.size}>
                    הוספת {selectedLibraryPhotoIds.size || ""} {selectedLibraryPhotoIds.size === 1 ? "תמונה" : "תמונות"} לספר
                  </button>
                </>
              )}
            </div>
          )}
        </section>

        <section className="stats-grid">
          <div><strong>{photos.length}</strong><span>תמונות</span></div>
          <div><strong>{pages.length}</strong><span>דפי תמונות</span></div>
          <div><strong>{printablePages.length}</strong><span>עמודים להדפסה</span></div>
          <div><strong>{photosPerPage}</strong><span>ברירת מחדל</span></div>
        </section>

        <label className="field">
          ברירת מחדל לתמונות בעמוד
          <select value={photosPerPage} onChange={(event) => changePhotosPerPage(Number(event.target.value))}>
            <option value={6}>עד 6 תמונות בעמוד</option>
            <option value={5}>עד 5 תמונות בעמוד</option>
            <option value={4}>עד 4 תמונות בעמוד</option>
            <option value={3}>עד 3 תמונות בעמוד</option>
            <option value={2}>עד 2 תמונות בעמוד</option>
            <option value={1}>תמונה אחת בעמוד</option>
          </select>
        </label>

        <details className="advanced-controls">
          <summary>עיצוב והגדרות מתקדמות</summary>
          <div className="advanced-controls-content">
        <section className="cover-controls">
          <h2>עריכת כריכה</h2>

          <label className="field">
            תמונת כריכה
            <select value={coverPhotoId} onChange={(event) => changeCoverPhoto(event.target.value)}>
              <option value="none">בלי תמונה</option>
              {customCover && <option value="custom">תמונת כריכה שהועלתה בנפרד</option>}
              {albumPhotos.map((photo, index) => (
                <option value={photo.id} key={photo.id}>
                  תמונה {index + 1} מתוך האלבום
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            העלאת תמונת כריכה אחרת
            <input type="file" accept={PHOTO_ACCEPT} onChange={handleCoverFile} disabled={isLoading || !hasCheckedSavedAlbum} />
          </label>

          <button type="button" onClick={clearCover} disabled={coverPhotoId === "none" && !customCover}>
            ניקוי כריכה
          </button>

          <label className="field">שורת תאריך/טקסט עליון<input value={coverDateText} onFocus={() => rememberFieldEdit("עריכת כריכה")} onChange={(event) => setCoverDateText(event.target.value)} placeholder={dateRange} /></label>
          <label className="field">שם האלבום<input value={title} onFocus={() => rememberFieldEdit("עריכת שם אלבום")} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="field">שורת משנה<input value={subtitle} onFocus={() => rememberFieldEdit("עריכת שורת משנה")} onChange={(event) => setSubtitle(event.target.value)} /></label>
          <label className="field">מלל חופשי<textarea rows={3} value={note} onFocus={() => rememberFieldEdit("עריכת מלל חופשי")} onChange={(event) => setNote(event.target.value)} /></label>
        </section>

        <label className="toggle-row">
          <input type="checkbox" checked={showPhotoDates} onChange={(event) => changeShowPhotoDates(event.target.checked)} />
          להציג תאריך גם על כל תמונה
        </label>

        <section className="design-controls">
          <h2>עיצוב האלבום</h2>
          <label className="field">
            גופן לכיתובים ולמלל
            <select value={albumFont} onChange={(event) => changeAlbumFont(event.target.value as AlbumFont)}>
              <option value="classic">קלאסי ונקי</option>
              <option value="rounded">עגול ורך</option>
              <option value="elegant">אלגנטי</option>
              <option value="playful">קליל ומשמח</option>
            </select>
          </label>
          <p className="hint">איורים מוסיפים מתוך כל עמוד בתצוגה המקדימה, ליד הכותרת.</p>
        </section>

        <section className="design-controls route-controls">
          <h2>עמוד מסלול / מפה</h2>
          <label className="toggle-row">
            <input type="checkbox" checked={showRoutePage} onChange={(event) => changeShowRoutePage(event.target.checked)} />
            להוסיף עמוד מסלול לאלבום
          </label>
          <label className="field">
            כותרת המסלול
            <input
              value={routeTitle}
              onFocus={() => rememberFieldEdit("עריכת כותרת מסלול")}
              onChange={(event) => setRouteTitle(event.target.value)}
            />
          </label>
          <div className="route-place-list">
            {routePlaces.map((place, index) => (
              <label className="field route-place-row" key={`route-place-${index}`}>
                יעד {index + 1}
                <span>
                  <input
                    value={place}
                    onFocus={() => rememberFieldEdit("עריכת יעד במסלול")}
                    onChange={(event) => updateRoutePlace(index, event.target.value)}
                  />
                  <button type="button" onClick={() => removeRoutePlace(index)} disabled={routePlaces.length <= 2}>
                    מחק
                  </button>
                </span>
              </label>
            ))}
          </div>
          <button type="button" onClick={addRoutePlace}>הוסף יעד</button>
          <p className="hint">המסלול נבנה לפי הסדר מלמעלה למטה ומודפס כעמוד A4 נפרד.</p>
        </section>

        <section className="actions">
          <p className="hint">הזיהוי משתמש בנתוני ה-GPS שבתמונה. לתמונות בלי GPS משתמשים ברמז המקום.</p>
          <label className="field">
            רמז לזיהוי מקום, לא חובה
            <input
              value={placeHint}
              onFocus={() => rememberFieldEdit("עריכת רמז לזיהוי")}
              onChange={(event) => setPlaceHint(event.target.value)}
              placeholder="לדוגמה: יוון, אוויה, אילת, מלון..."
            />
          </label>
          <button type="button" onClick={fillAllCaptions} disabled={!photos.length || isLoading}>
            זיהוי מקום וכיתוב לכל התמונות
          </button>
          <button type="button" onClick={clearAutomaticCaptions} disabled={!photos.length}>
            מחיקת כיתובים אוטומטיים בלבד
          </button>
        </section>

        <section className="actions save-actions">
          <button type="button" onClick={saveAlbumForLater} disabled={isLoading || isSavingAlbum || (!photos.length && !customCover)}>
            {isSavingAlbum ? "שומרת..." : "שמור אלבום להמשך"}
          </button>
          <button type="button" onClick={exportAlbumToFile} disabled={isLoading || isExportingAlbum || (!photos.length && !customCover)}>
            {isExportingAlbum ? "מכינה קובץ..." : "ייצוא אלבום לקובץ"}
          </button>
          <label className={`file-action ${isLoading ? "disabled" : ""}`}>
            ייבוא קובץ אלבום שמור
            <input type="file" accept=".json,.tamar-album.json,application/json" onChange={importAlbumFromFile} disabled={isLoading || !hasCheckedSavedAlbum} />
          </label>
          <p className="hint">הייבוא כאן מיועד רק לקובץ אלבום שייצאת, לא לבחירת תמונות רגילות.</p>
          <button type="button" onClick={loadSavedAlbumForLater} disabled={isLoading || !savedAt}>
            המשך מאלבום שמור
          </button>
          {savedAt && (
            <p className="hint">שמירה אחרונה: {new Date(savedAt).toLocaleString("he-IL")}</p>
          )}
          <button type="button" onClick={deleteSavedAlbumForLater} disabled={!savedAt}>
            מחיקת שמירה
          </button>
        </section>
          </div>
        </details>

        <section className="actions">
          <button type="button" onClick={restoreUndoSnapshot} disabled={!undoSnapshot}>
            {undoLabel ? `בטל פעולה אחרונה: ${undoLabel}` : "בטל פעולה אחרונה"}
          </button>
          <button type="button" onClick={restoreRedoSnapshot} disabled={!redoSnapshot}>
            {redoLabel ? `בצע מחדש: ${redoLabel}` : "בצע מחדש"}
          </button>
          <button className="primary" type="button" onClick={() => window.print()}>שמירה כ-PDF / הדפסה</button>
          <button type="button" onClick={clearPhotos} disabled={!photos.length}>ניקוי תמונות</button>
        </section>
      </aside>

      <section id="album-preview" className="preview-panel" aria-label="תצוגה מקדימה של האלבום">
        <div className="preview-header">
          <div>
            <span>תצוגה לפני הדפסה</span>
            <strong>דפדוף כמו ספר</strong>
          </div>
          <p>{activeSpread === 0 ? "געי בטקסט שעל הכריכה כדי לערוך אותו." : "אפשר לגרור תמונה על תמונה אחרת כדי להחליף ביניהן, או לגרור למשבצת פנויה בעמוד האחרון."}</p>
        </div>

        <div className="book-toolbar" aria-label="ניווט בתצוגת ספר">
          <button type="button" onClick={() => setCurrentSpread((spread) => Math.max(0, Math.min(spread, totalSpreads - 1) - 1))} disabled={activeSpread === 0}>
            עמוד קודם
          </button>
          <span>{spreadLabel}</span>
          <button type="button" onClick={() => setCurrentSpread((spread) => Math.min(totalSpreads - 1, spread + 1))} disabled={activeSpread >= totalSpreads - 1}>
            עמוד הבא
          </button>
        </div>

        <div className={`print-area book-preview ${activeSpread === 0 ? "cover-mode" : "spread-mode"}`}>
          {printablePages.map((page, pageNumber) => renderPrintablePage(page, visiblePageIndexes.includes(pageNumber)))}
        </div>
      </section>
    </main>
  );
}
