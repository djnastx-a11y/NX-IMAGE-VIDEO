import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ImageOperation, Job, Module } from "@nx/shared";
import { api } from "../lib/api";
import { useToast } from "../lib/store";
import { Layout } from "../components/Layout";
import { ImageComposer, type ImageComposerInit } from "../components/ImageComposer";
import { VideoComposer, type VideoComposerInit } from "../components/VideoComposer";
import { ResultsFeed } from "../components/ResultsFeed";
import { Segmented } from "../components/ui";

/**
 * Composer on the left, live queue + results on the right (stacked on mobile).
 * `module` fixed for NX Image / NX Video; the Generate page lets you switch.
 */
export function StudioPage({ module: fixed }: { module?: Module }) {
  const [params, setParams] = useSearchParams();
  const { push } = useToast();
  const [switchable, setSwitchable] = useState<Module>("video");
  const module = fixed ?? switchable;
  const [imageInit, setImageInit] = useState<ImageComposerInit | undefined>();
  const [videoInit, setVideoInit] = useState<VideoComposerInit | undefined>();

  // Deep links: ?from=<job> (reuse settings), ?image=<media> (Animate), ?source=<media>&op=edit (modify an image)
  useEffect(() => {
    const from = params.get("from");
    const image = params.get("image");
    const video = params.get("video");
    const source = params.get("source");
    const op = params.get("op") as ImageOperation | null;
    if (from) {
      api.job(from).then(
        (job) => (job.module === "image" ? setImageInit({ job }) : setVideoInit({ job })),
        (e) => push("error", e.message),
      );
    } else if (image && module === "video") setVideoInit({ imageMediaId: image });
    else if (video && module === "video") setVideoInit({ videoMediaId: video });
    else if (source && module === "image") setImageInit({ sourceMediaId: source, op: op ?? "edit" });
    else if (op && module === "image") setImageInit({ op });
    if (from || image || video || source || op) setParams({}, { replace: true });
  }, [params]);

  const reuse = useMemo(
    () => (job: Job) => {
      if (!fixed) setSwitchable(job.module);
      if (job.module === "image") setImageInit({ job });
      else setVideoInit({ job });
      window.scrollTo({ top: 0, behavior: "smooth" });
      push("info", "Réglages chargés dans le panneau");
    },
    [fixed, push],
  );

  // On phones the results sit under the composer: bring the new job into view after Generate.
  const results = useRef<HTMLDivElement>(null);
  const onCreated = () => {
    if (window.matchMedia("(max-width: 1060px)").matches) setTimeout(() => results.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
  };

  const title = fixed === "image" ? "NX Image" : fixed === "video" ? "NX Video" : "Generate";
  return (
    <Layout
      title={title}
      actions={
        !fixed && (
          <div style={{ width: 170 }}>
            <Segmented value={switchable} onChange={setSwitchable} options={[{ value: "image" as const, label: "Image" }, { value: "video" as const, label: "Vidéo" }]} />
          </div>
        )
      }
    >
      <div className="studio">
        {module === "image" ? <ImageComposer init={imageInit} onCreated={onCreated} /> : <VideoComposer init={videoInit} onCreated={onCreated} />}
        <div ref={results} style={{ scrollMarginTop: 72 }}>
          <ResultsFeed module={fixed ? module : undefined} onReuse={reuse} title={fixed ? "Résultats" : "Toutes les générations"} />
        </div>
      </div>
    </Layout>
  );
}
