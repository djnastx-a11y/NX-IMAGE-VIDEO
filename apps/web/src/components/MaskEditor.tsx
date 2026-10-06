import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Media } from "@nx/shared";
import { Icon } from "./icons";

export interface MaskEditorHandle {
  /** PNG mask at the source's native size: white = area to regenerate. Null when nothing is painted. */
  exportMask(): Promise<Blob | null>;
  isEmpty(): boolean;
}

/**
 * Paint the area to regenerate over the source image (mouse, pen or finger).
 * Brush / eraser, brush size, clear, restore (undo).
 */
export const MaskEditor = forwardRef<MaskEditorHandle, { source: Media; onChange?(hasMask: boolean): void }>(function MaskEditor({ source, onChange }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"brush" | "eraser">("brush");
  const [size, setSize] = useState(48);
  const history = useRef<ImageData[]>([]);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const W = source.width ?? 1024;
  const H = source.height ?? 1024;

  const ctx = () => canvas.current!.getContext("2d", { willReadFrequently: true })!;
  const painted = useCallback(() => {
    const d = ctx().getImageData(0, 0, W, H).data;
    for (let i = 3; i < d.length; i += 16) if (d[i]! > 0) return true;
    return false;
  }, [W, H]);

  useEffect(() => {
    const c = canvas.current!;
    c.width = W;
    c.height = H;
    history.current = [];
    onChange?.(false);
  }, [source.id, W, H]);

  const snapshot = () => {
    history.current.push(ctx().getImageData(0, 0, W, H));
    if (history.current.length > 25) history.current.shift();
  };

  const pos = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const scale = () => W / canvas.current!.getBoundingClientRect().width;

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const g = ctx();
    g.globalCompositeOperation = mode === "brush" ? "source-over" : "destination-out";
    g.strokeStyle = "rgba(255, 64, 120, 0.6)";
    g.lineCap = "round";
    g.lineJoin = "round";
    g.lineWidth = size * scale();
    g.beginPath();
    g.moveTo(from.x, from.y);
    g.lineTo(to.x, to.y);
    g.stroke();
  };

  useImperativeHandle(ref, () => ({
    isEmpty: () => !painted(),
    async exportMask() {
      if (!painted()) return null;
      const src = ctx().getImageData(0, 0, W, H);
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const o = out.getContext("2d")!;
      const img = o.createImageData(W, H);
      for (let i = 0; i < src.data.length; i += 4) {
        const v = src.data[i + 3]! > 10 ? 255 : 0;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      o.putImageData(img, 0, 0);
      return new Promise((res) => out.toBlob((b) => res(b), "image/png"));
    },
  }));

  return (
    <div className="col">
      <div className="mask-editor" style={{ aspectRatio: `${W}/${H}` }}>
        <img src={source.url} alt="Source" draggable={false} />
        <canvas
          ref={canvas}
          style={{ cursor: "crosshair" }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            snapshot();
            drawing.current = true;
            const p = pos(e);
            last.current = p;
            stroke(p, { x: p.x + 0.1, y: p.y + 0.1 });
          }}
          onPointerMove={(e) => {
            if (!drawing.current || !last.current) return;
            const p = pos(e);
            stroke(last.current, p);
            last.current = p;
          }}
          onPointerUp={() => {
            drawing.current = false;
            last.current = null;
            onChange?.(painted());
          }}
        />
      </div>
      <div className="row wrap">
        <div className="seg" style={{ flex: "none" }}>
          <button type="button" className={mode === "brush" ? "on" : ""} onClick={() => setMode("brush")}>
            <Icon name="brush" style={{ width: 14, height: 14, verticalAlign: -2 }} /> Pinceau
          </button>
          <button type="button" className={mode === "eraser" ? "on" : ""} onClick={() => setMode("eraser")}>
            <Icon name="eraser" style={{ width: 14, height: 14, verticalAlign: -2 }} /> Gomme
          </button>
        </div>
        <label className="row small muted grow" style={{ minWidth: 140 }}>
          Taille
          <input className="range" type="range" min={6} max={160} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Taille du pinceau" />
        </label>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            snapshot();
            ctx().clearRect(0, 0, W, H);
            onChange?.(false);
          }}
        >
          Effacer
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={!history.current.length}
          onClick={() => {
            const prev = history.current.pop();
            if (prev) ctx().putImageData(prev, 0, 0);
            onChange?.(painted());
          }}
        >
          <Icon name="undo" /> Restaurer
        </button>
      </div>
    </div>
  );
});
