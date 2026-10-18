import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MAX_ZOOM,
  clamp,
  cropMetrics,
  loadCropSource,
  renderCroppedPhoto,
  type CropSource,
  type Point,
} from "../profilePhoto";
import { Icon } from "./Icon";
import { useInstance } from "../instance";

type ProfileModalProps = {
  open: boolean;
  /** The custom mailbox whose photo is edited. */
  accountId: string;
  /** Its address, for the initial shown without a photo. */
  emailAddress: string;
  photoUrl: string | null;
  onClose: () => void;
  onPhotoChange: (url: string | null) => void;
};

type DragState = {
  active: boolean;
  startX: number;
  startY: number;
  origin: Point;
};

const EMPTY_OFFSET: Point = { x: 0, y: 0 };

export function ProfileModal({ open, accountId, emailAddress, photoUrl, onClose, onPhotoChange }: ProfileModalProps) {
  const photoPath = `/api/profile/photo?accountId=${encodeURIComponent(accountId)}`;
  const { brandName } = useInstance();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState>({
    active: false,
    startX: 0,
    startY: 0,
    origin: EMPTY_OFFSET,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cropSource, setCropSource] = useState<CropSource | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Point>(EMPTY_OFFSET);

  useEffect(() => {
    return () => {
      if (cropSource) URL.revokeObjectURL(cropSource.url);
    };
  }, [cropSource]);

  const metrics = useMemo(
    () => cropSource ? cropMetrics(cropSource, zoom) : null,
    [cropSource, zoom],
  );
  const boundedOffset = useMemo(() => {
    if (!metrics) return offset;
    return {
      x: clamp(offset.x, -metrics.maxX, metrics.maxX),
      y: clamp(offset.y, -metrics.maxY, metrics.maxY),
    };
  }, [metrics, offset]);

  if (!open) return null;

  const resetTransform = () => {
    setZoom(1);
    setOffset(EMPTY_OFFSET);
  };

  const clearCrop = () => {
    setCropSource(null);
    resetTransform();
  };

  const announcePhotoChange = (url: string | null) => {
    onPhotoChange(url);
    window.dispatchEvent(new CustomEvent("profile-photo-changed", { detail: url }));
  };

  const choosePhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setBusy(true);
    setError(null);
    try {
      const nextSource = await loadCropSource(file);
      setCropSource(nextSource);
      resetTransform();
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "That image could not be opened",
      );
    } finally {
      setBusy(false);
    }
  };

  const saveCrop = async () => {
    if (!cropSource) return;
    setBusy(true);
    setError(null);
    try {
      const normalized = await renderCroppedPhoto(cropSource, zoom, boundedOffset);
      const form = new FormData();
      form.append(
        "photo",
        new File([normalized], "profile.jpg", { type: "image/jpeg" }),
      );
      const response = await fetch(photoPath, {
        method: "PUT",
        body: form,
      });
      const data = await response.json().catch(() => ({})) as {
        error?: string;
        version?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "Could not save profile photo");
      }

      announcePhotoChange(
        `${photoPath}&v=${encodeURIComponent(data.version ?? String(Date.now()))}`,
      );
      clearCrop();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Could not save profile photo",
      );
    } finally {
      setBusy(false);
    }
  };

  const cancelCrop = () => {
    clearCrop();
    setError(null);
  };

  const changeZoom = (nextZoom: number) => {
    if (!cropSource) return;
    const next = clamp(nextZoom, 1, MAX_ZOOM);
    const nextMetrics = cropMetrics(cropSource, next);
    setZoom(next);
    setOffset((current) => ({
      x: clamp(current.x, -nextMetrics.maxX, nextMetrics.maxX),
      y: clamp(current.y, -nextMetrics.maxY, nextMetrics.maxY),
    }));
  };

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!cropSource || busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      origin: boundedOffset,
    };
  };

  const dragPhoto = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active || !metrics) return;
    const nextX = dragRef.current.origin.x + event.clientX - dragRef.current.startX;
    const nextY = dragRef.current.origin.y + event.clientY - dragRef.current.startY;
    setOffset({
      x: clamp(nextX, -metrics.maxX, metrics.maxX),
      y: clamp(nextY, -metrics.maxY, metrics.maxY),
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const removePhoto = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(photoPath, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not remove profile photo");
      announcePhotoChange(null);
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : "Could not remove profile photo",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="profile-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Profile settings"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !cropSource) onClose();
      }}
    >
      <section className={`profile-modal ${cropSource ? "profile-modal-cropping" : ""}`}>
        <header>
          <div>
            <span className="eyebrow">Profile</span>
            <h2>{cropSource ? "Adjust profile photo" : "Mailbox profile"}</h2>
          </div>
          <button
            className="profile-modal-close"
            type="button"
            aria-label={cropSource ? "Cancel photo adjustment" : "Close profile settings"}
            onClick={cropSource ? cancelCrop : onClose}
          >
            ×
          </button>
        </header>

        {cropSource && metrics ? (
          <div className="profile-crop-editor">
            <div
              className="profile-crop-stage"
              onPointerDown={beginDrag}
              onPointerMove={dragPhoto}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              aria-label="Drag photo to reposition"
            >
              <img
                src={cropSource.url}
                alt="Profile crop preview"
                draggable={false}
                style={{
                  width: `${metrics.displayedWidth}px`,
                  height: `${metrics.displayedHeight}px`,
                  transform: `translate(calc(-50% + ${boundedOffset.x}px), calc(-50% + ${boundedOffset.y}px))`,
                }}
              />
              <div className="profile-crop-ring" aria-hidden="true" />
            </div>

            <div className="profile-crop-help">
              Drag to reposition your photo inside the frame.
            </div>

            <div className="profile-crop-controls">
              <div className="profile-crop-zoom-row">
                <span>Scale</span>
                <input
                  aria-label="Profile photo scale"
                  type="range"
                  min="1"
                  max={String(MAX_ZOOM)}
                  step="0.01"
                  value={zoom}
                  onChange={(event) => changeZoom(Number(event.target.value))}
                />
                <strong>{Math.round(zoom * 100)}%</strong>
              </div>
              <button type="button" disabled={busy} onClick={resetTransform}>
                Reset
              </button>
            </div>

            <div className="profile-crop-actions">
              <button type="button" disabled={busy} onClick={cancelCrop}>
                Cancel
              </button>
              <button
                className="profile-photo-primary"
                type="button"
                disabled={busy}
                onClick={() => void saveCrop()}
              >
                {busy ? "Saving…" : "Save photo"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="profile-photo-section">
              <div className="profile-photo-preview" aria-hidden="true">
                {photoUrl ? <img src={photoUrl} alt="" /> : <span>{emailAddress.charAt(0).toUpperCase() || "?"}</span>}
              </div>
              <div className="profile-photo-copy">
                <strong>Profile photo</strong>
                <span>
                  This photo appears in the app header and beside messages you send inside {brandName}.
                </span>
                <div className="profile-photo-actions">
                  <button
                    className="profile-photo-primary"
                    type="button"
                    disabled={busy}
                    onClick={() => inputRef.current?.click()}
                  >
                    <Icon name="compose" size={15} />
                    {busy ? "Working…" : photoUrl ? "Change photo" : "Choose photo"}
                  </button>
                  {photoUrl ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void removePhoto()}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="profile-outbound-note">
              <Icon name="send" size={14} />
              <span>
                Your photo is used for outbound messages inside {brandName}. External email apps choose their own sender avatar and may not display this photo.
              </span>
            </div>
          </>
        )}

        <input
          ref={inputRef}
          className="profile-photo-input"
          type="file"
          accept="image/*"
          onChange={(event) => void choosePhoto(event)}
        />
        {error ? <div className="profile-modal-error" role="alert">{error}</div> : null}
        {!cropSource ? (
          <div className="profile-modal-note">
            <Icon name="lock" size={14} />
            <span>Your profile photo is stored privately in your existing mail storage.</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
