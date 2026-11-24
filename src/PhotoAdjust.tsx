import { CSSProperties, PointerEvent as ReactPointerEvent, useRef, useState } from "react";

// The part of the photo that is shown, as fractions (0–1) of its width and height.
export type PhotoCrop = { x: number; y: number; w: number; h: number };

type AdjustablePhoto = {
  url: string;
  width?: number;
  height?: number;
  zoom?: number;
  crop?: PhotoCrop;
};

export const FULL_CROP: PhotoCrop = { x: 0, y: 0, w: 1, h: 1 };
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 3;
const MIN_CROP = 0.08;

export function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function cleanZoom(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value - 1) > 0.01
    ? clampNumber(value, MIN_ZOOM, MAX_ZOOM)
    : undefined;
}

export function cleanCrop(value: unknown): PhotoCrop | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y, w, h } = value as Record<string, unknown>;
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
  const width = clampNumber(w as number, MIN_CROP, 1);
  const height = clampNumber(h as number, MIN_CROP, 1);
  const crop = {
    x: clampNumber(x as number, 0, 1 - width),
    y: clampNumber(y as number, 0, 1 - height),
    w: width,
    h: height,
  };
  return crop.w > 0.995 && crop.h > 0.995 ? undefined : crop;
}

// Shape (width / height) of the part of the photo that is shown.
export function croppedRatio(photo: AdjustablePhoto) {
  const crop = photo.crop || FULL_CROP;
  return photo.width && photo.height ? (photo.width * crop.w) / (photo.height * crop.h) : 1;
}

// CSS variables that place the cropped, zoomed photo inside its frame (see .adj-box in app.css).
export function photoAdjustStyle(photo: AdjustablePhoto): CSSProperties {
  const crop = photo.crop || FULL_CROP;
  const zoom = photo.zoom ?? 1;
  return {
    "--r": croppedRatio(photo),
    "--size": Math.min(zoom, 1),
    "--zoom": Math.max(zoom, 1),
    "--cx": crop.x,
    "--cy": crop.y,
    "--cw": crop.w,
    "--ch": crop.h,
  } as CSSProperties;
}

const CROP_SHAPES: Array<{ id: string; label: string; ratio: number | "original" | null }> = [
  { id: "free", label: "חופשי", ratio: null },
  { id: "original", label: "מקורי", ratio: "original" },
  { id: "square", label: "ריבוע", ratio: 1 },
  { id: "portrait", label: "עומד 3:4", ratio: 3 / 4 },
  { id: "landscape", label: "שוכב 4:3", ratio: 4 / 3 },
  { id: "wide", label: "רחב 16:9", ratio: 16 / 9 },
];

type CropDrag = {
  mode: "move" | "nw" | "ne" | "sw" | "se";
  pointerId: number;
  startX: number;
  startY: number;
  start: PhotoCrop;
};

export function PhotoAdjustDialog({ photo, onSave, onClose }: {
  photo: AdjustablePhoto;
  onSave: (zoom: number, crop: PhotoCrop | undefined) => void;
  onClose: () => void;
}) {
  const [crop, setCrop] = useState<PhotoCrop>(photo.crop || FULL_CROP);
  const [zoom, setZoom] = useState(photo.zoom ?? 1);
  const [shapeId, setShapeId] = useState("free");
  const areaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<CropDrag | null>(null);
  const imageWidth = photo.width || 1;
  const imageHeight = photo.height || 1;
  const imageRatio = imageWidth / imageHeight;
  const shape = CROP_SHAPES.find((item) => item.id === shapeId) || CROP_SHAPES[0];
  // Locked shape in pixels (width / height), or null for a free crop.
  const lockedRatio = shape.ratio === "original" ? imageRatio : shape.ratio;

  function pickShape(nextShapeId: string) {
    setShapeId(nextShapeId);
    const next = CROP_SHAPES.find((item) => item.id === nextShapeId);
    if (!next || next.ratio === null) return;
    const target = next.ratio === "original" ? imageRatio : next.ratio;
    // Largest crop with this shape, centred on the current crop.
    let w = 1;
    let h = imageRatio / target;
    if (h > 1) {
      h = 1;
      w = target / imageRatio;
    }
    const centerX = crop.x + crop.w / 2;
    const centerY = crop.y + crop.h / 2;
    setCrop({
      x: clampNumber(centerX - w / 2, 0, 1 - w),
      y: clampNumber(centerY - h / 2, 0, 1 - h),
      w,
      h,
    });
  }

  function pointerPosition(event: ReactPointerEvent) {
    const rect = areaRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };
    return {
      x: clampNumber((event.clientX - rect.left) / rect.width, 0, 1),
      y: clampNumber((event.clientY - rect.top) / rect.height, 0, 1),
    };
  }

  function startDrag(event: ReactPointerEvent, mode: CropDrag["mode"]) {
    event.preventDefault();
    event.stopPropagation();
    const position = pointerPosition(event);
    areaRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = { mode, pointerId: event.pointerId, startX: position.x, startY: position.y, start: crop };
  }

  function moveDrag(event: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = pointerPosition(event);
    const start = drag.start;
    if (drag.mode === "move") {
      setCrop({
        ...start,
        x: clampNumber(start.x + position.x - drag.startX, 0, 1 - start.w),
        y: clampNumber(start.y + position.y - drag.startY, 0, 1 - start.h),
      });
      return;
    }
    // Resize from a corner; the opposite corner stays in place.
    const fromLeft = drag.mode.includes("w");
    const fromTop = drag.mode.includes("n");
    const anchorX = fromLeft ? start.x + start.w : start.x;
    const anchorY = fromTop ? start.y + start.h : start.y;
    const roomX = fromLeft ? anchorX : 1 - anchorX;
    const roomY = fromTop ? anchorY : 1 - anchorY;
    let w = clampNumber(Math.abs(position.x - anchorX), MIN_CROP, roomX);
    let h = clampNumber(Math.abs(position.y - anchorY), MIN_CROP, roomY);
    if (lockedRatio) {
      const heightPerWidth = imageRatio / lockedRatio;
      h = w * heightPerWidth;
      if (h > roomY) {
        h = roomY;
        w = h / heightPerWidth;
      }
      if (h < MIN_CROP) {
        h = MIN_CROP;
        w = Math.min(roomX, h / heightPerWidth);
      }
    }
    setCrop({ x: fromLeft ? anchorX - w : anchorX, y: fromTop ? anchorY - h : anchorY, w, h });
  }

  function endDrag(event: ReactPointerEvent) {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }

  const zoomPercent = Math.round(zoom * 100);
  const preview = { ...photo, crop, zoom };

  return (
    <div className="adjust-overlay" role="dialog" aria-modal="true" aria-labelledby="adjust-title">
      <div className="adjust-panel">
        <header>
          <h2 id="adjust-title">גודל וחיתוך</h2>
          <p>גררי את המסגרת כדי לבחור איזה חלק מהתמונה יופיע. מהפינות אפשר להגדיל או להקטין את החיתוך.</p>
        </header>
        <div className="adjust-body">
          <div className="crop-shapes" role="group" aria-label="צורת החיתוך">
            {CROP_SHAPES.map((item) => (
              <button
                type="button"
                key={item.id}
                className={item.id === shapeId ? "is-active" : ""}
                onClick={() => pickShape(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="crop-stage">
            <div
              className="crop-area"
              ref={areaRef}
              style={{ aspectRatio: `${imageWidth} / ${imageHeight}`, width: `min(100%, calc(46dvh * ${imageRatio}))` }}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <img src={photo.url} alt="" draggable={false} />
              <div
                className="crop-box"
                style={{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.w * 100}%`,
                  height: `${crop.h * 100}%`,
                }}
                onPointerDown={(event) => startDrag(event, "move")}
              >
                {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                  <span
                    key={corner}
                    className={`crop-handle crop-${corner}`}
                    onPointerDown={(event) => startDrag(event, corner)}
                  />
                ))}
              </div>
            </div>
          </div>
          <label className="zoom-field">
            <span>גודל התמונה בעמוד: <strong>{zoomPercent}%</strong></span>
            <input
              type="range"
              min={MIN_ZOOM * 100}
              max={MAX_ZOOM * 100}
              step={5}
              value={zoomPercent}
              onChange={(event) => setZoom(Number(event.target.value) / 100)}
            />
            <small>
              {zoomPercent < 100
                ? "התמונה קטנה יותר בתוך המשבצת. הפרופורציות נשמרות."
                : zoomPercent > 100
                  ? "התמונה מוגדלת וממלאת את המשבצת, והשוליים שלה נחתכים."
                  : "100%: התמונה ממלאת את המשבצת."}
            </small>
          </label>
          <div className="adjust-preview-row">
            <span>כך זה ייראה בעמוד:</span>
            <div
              className="adjust-preview photo-frame adj-frame"
              style={{ ...photoAdjustStyle(preview), width: `${Math.round(clampNumber(110 * croppedRatio(preview), 60, 190))}px` }}
            >
              <div className="adj-box"><img src={photo.url} alt="" draggable={false} /></div>
            </div>
          </div>
          <p className="hint">טיפ: בעמוד עצמו אפשר גם לפתוח או לצבוט את התמונה בשתי אצבעות.</p>
        </div>
        <footer>
          <button className="primary" type="button" onClick={() => onSave(zoom, cleanCrop(crop))}>שמירה</button>
          <button
            type="button"
            onClick={() => {
              setCrop(FULL_CROP);
              setZoom(1);
              setShapeId("free");
            }}
          >
            איפוס
          </button>
          <button type="button" onClick={onClose}>ביטול</button>
        </footer>
      </div>
    </div>
  );
}
