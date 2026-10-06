import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Real-browser walkthrough of NX STUDIO with the mock engines.
 * Runs against a server started on an EMPTY database (the first test creates the admin through the UI).
 */
const ADMIN = { name: "Jb", email: "jb@nx.studio", password: "nx-studio-e2e-pass" };
const SHOTS = process.env.E2E_SHOTS ?? "e2e/.shots";
const FIX = "e2e/.fixtures";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  mkdirSync(FIX, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  // a 16:9 photo-like test picture with text in it
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720", "-frames:v", "1", path.join(FIX, "street.png")]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24", "-t", "2", "-pix_fmt", "yuv420p", path.join(FIX, "clip.mp4")]);
});

async function signIn(page: Page) {
  await page.goto("/");
  const create = page.getByRole("button", { name: "Créer le compte" });
  const login = page.getByRole("button", { name: "Se connecter" });
  await expect(create.or(login)).toBeVisible();
  if (await create.isVisible()) {
    await page.getByLabel("Nom").fill(ADMIN.name);
  }
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Mot de passe").fill(ADMIN.password);
  await (await create.isVisible() ? create : login).click();
  await expect(page.locator(".topbar h1")).toBeVisible();
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: false });

/** Waits for the newest job card to finish, checking that live progress was shown on the way. */
async function newestCardCompletes(page: Page, opts: { seeProgress?: boolean } = {}): Promise<Locator> {
  const card = page.locator(".job-card").first();
  if (opts.seeProgress !== false) await expect(card.locator(".pct")).toBeVisible();
  await expect(card).toHaveAttribute("data-status", "completed", { timeout: 90_000 });
  return card;
}

/**
 * Playwright's bundled Chromium has no H.264 decoder (Chrome and Safari do), so videos are checked
 * by downloading them with the browser's session and probing the file with ffprobe.
 */
async function probeVideo(page: Page, url: string) {
  const res = await page.request.get(url);
  expect(res.ok()).toBe(true);
  const file = path.join(test.info().outputDir, `probe-${Date.now()}.mp4`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, await res.body());
  const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name:format=duration", "-of", "json", file]).toString());
  return { w: info.streams[0].width as number, h: info.streams[0].height as number, codec: info.streams[0].codec_name as string, d: Number(info.format.duration) };
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page should not scroll horizontally").toBeLessThanOrEqual(1);
}

test.describe("desktop", () => {
  test.skip(({ isMobile }) => isMobile, "desktop flow");

  test("first run: create the admin account, then sign out and back in", async ({ page }) => {
    await signIn(page);
    await expect(page.locator(".sidebar")).toContainText("NX STUDIO");
    await shot(page, "01-generate");
    await page.goto("/settings");
    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page.getByRole("button", { name: "Se connecter" })).toBeVisible();
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Mot de passe").fill("wrong-password!");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page.locator(".job-error")).toBeVisible();
    await page.getByLabel("Mot de passe").fill(ADMIN.password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page.locator(".topbar h1")).toHaveText("Generate");
  });

  test("projects: create one and make it the current project", async ({ page }) => {
    await signIn(page);
    await page.goto("/projects");
    for (const name of ["Australia Street", "Halloween"]) {
      await page.getByRole("button", { name: "Nouveau" }).click();
      await page.getByLabel("Nom").fill(name);
      await page.getByRole("button", { name: "Créer", exact: true }).click();
      await expect(page.locator(".project-card", { hasText: name })).toBeVisible();
    }
    await shot(page, "02-projects");
    await page.locator(".project-card", { hasText: "Australia Street" }).getByRole("button", { name: "Image" }).click();
    await expect(page).toHaveURL(/\/image$/);
    await expect(page.locator(".topbar select[aria-label=Projet]")).toHaveValue(/[0-9a-f-]{36}/);
  });

  test("final goal: image → Animate in NX VIDEO → 10 s 9:16 drone → library → download, variation, extend", async ({ page }) => {
    await signIn(page);
    await page.goto("/image");
    // NX IMAGE text to image
    await page.getByPlaceholder("Décris l'image…").fill("A DJ on a rooftop in Sydney at night, neon lights, cinematic");
    await page.getByRole("radio", { name: "9:16" }).click();
    await page.getByRole("button", { name: /GENERATE/ }).click();
    const imageCard = await newestCardCompletes(page);
    await expect(imageCard.locator(".job-media img")).toBeVisible();
    await shot(page, "03-image-done");

    // Animate in NX VIDEO
    await imageCard.getByRole("button", { name: "Animate" }).click();
    await expect(page).toHaveURL(/\/video/);
    await expect(page.getByRole("tab", { name: "Image to Video" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".slot.filled img")).toBeVisible();
    await page.getByPlaceholder(/Décris le mouvement/).fill("The DJ raises his hands, crowd lights pulse, slow drone pull-back");
    await page.getByRole("radio", { name: "10 s" }).click();
    await page.getByRole("radio", { name: "9:16" }).click();
    await page.getByRole("button", { name: "Drone", exact: true }).click();
    await page.getByLabel("Intensité caméra").fill("8");
    await shot(page, "04-video-settings");
    await page.getByRole("button", { name: /GENERATE/ }).click();
    const card = page.locator(".job-card").first();
    await expect(card.locator(".pct")).toBeVisible();
    await shot(page, "05-video-progress");
    await expect(card).toHaveAttribute("data-status", "completed", { timeout: 90_000 });
    await expect(card.locator(".job-meta")).toContainText("10s");
    await expect(card.locator(".job-meta")).toContainText("9:16");
    await expect(card.locator(".job-meta")).toContainText("Drone");
    const src = await card.locator("video").getAttribute("src");
    expect(src).toMatch(/^\/api\/media\/.+\/file$/);
    const dims = await probeVideo(page, src!);
    expect(dims.codec).toBe("h264");
    expect(dims.h).toBeGreaterThan(dims.w); // 9:16
    expect(dims.d).toBeGreaterThan(9.5);
    expect(dims.d).toBeLessThan(10.6);
    await shot(page, "06-video-done");

    // Library → viewer → download MP4
    await page.getByRole("link", { name: "Library" }).click();
    await page.getByRole("radio", { name: "Videos" }).click();
    await expect(page.locator(".media-tile")).toHaveCount(1);
    await shot(page, "07-library");
    await page.locator(".media-tile").first().click();
    const dl = page.waitForEvent("download");
    await page.getByRole("link", { name: "Télécharger MP4" }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/\.mp4$/);
    const saved = path.join(test.info().outputDir, file.suggestedFilename());
    await file.saveAs(saved);
    expect(statSync(saved).size).toBeGreaterThan(50_000);

    // Variation + Extend from the viewer
    await page.getByRole("button", { name: "Varier" }).click();
    await page.getByRole("radio", { name: "+5 s" }).click();
    await page.getByRole("button", { name: "Extend" }).click();
    await page.keyboard.press("Escape");
    await page.goto("/video");
    const cards = page.locator(".job-card");
    // 1 original + 2 variations + 1 extend
    await expect(cards).toHaveCount(4);
    await expect(page.locator('.job-card[data-status="completed"]')).toHaveCount(4, { timeout: 120_000 });
    const extended = page.locator(".job-card", { hasText: "extend" }).first();
    await expect(extended.locator(".job-meta")).toContainText("+5s");
    const ext = await probeVideo(page, (await extended.locator("video").getAttribute("src"))!);
    expect(ext.d).toBeGreaterThan(14.5);
    await shot(page, "08-variations-extend");

    // Reuse the settings of the original job
    await page.locator(".job-card").last().getByTitle("Réutiliser les réglages").click();
    await expect(page.getByPlaceholder(/Décris le mouvement/)).toHaveValue(/raises his hands/);
    await expect(page.getByRole("button", { name: "Drone", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("NX IMAGE: upload, image to image, natural-language edit, inpaint, outpaint, upscale, export", async ({ page }) => {
    await signIn(page);
    await page.goto("/image");
    await page.getByRole("tab", { name: "Image to Image" }).click();
    await page.locator(".slot input[type=file]").first().setInputFiles(path.join(FIX, "street.png"));
    await expect(page.locator(".slot.filled img")).toBeVisible();
    await page.getByPlaceholder("Décris l'image…").fill("Same street, watercolor style");
    await page.getByRole("button", { name: /GENERATE/ }).click();
    await newestCardCompletes(page);

    await page.getByRole("tab", { name: "Édition" }).click();
    await expect(page.locator(".slot.filled img")).toBeVisible(); // source kept between tabs
    await page.getByRole("button", { name: "Remplace uniquement le décor par une rue de nuit sous la pluie." }).click();
    await expect(page.locator(".intent")).toContainText("Compris");
    await page.getByRole("button", { name: /GENERATE/ }).click();
    await newestCardCompletes(page);
    await shot(page, "09-edit");

    await page.getByRole("tab", { name: "Inpainting" }).click();
    const canvas = page.locator(".mask-editor canvas");
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 12 });
    await page.mouse.up();
    await page.getByPlaceholder("Ce qui doit apparaître dans la zone peinte").fill("a red vintage car");
    await page.getByRole("button", { name: /GENERATE/ }).click();
    await newestCardCompletes(page);
    await shot(page, "10-inpaint");

    await page.getByRole("tab", { name: "Outpainting" }).click();
    await page.getByRole("radio", { name: "Vers un format" }).click();
    await page.getByRole("radio", { name: "9:16" }).click();
    await page.getByRole("button", { name: /GENERATE/ }).click();
    const out = await newestCardCompletes(page);
    const outDims = await out.locator(".job-media img").evaluate((i: HTMLImageElement) => ({ w: i.naturalWidth, h: i.naturalHeight }));
    expect(outDims.h / outDims.w).toBeCloseTo(16 / 9, 1);

    await page.getByRole("tab", { name: "Upscale" }).click();
    await page.getByRole("button", { name: /GENERATE/ }).click();
    const up = await newestCardCompletes(page);
    const upDims = await up.locator(".job-media img").evaluate((i: HTMLImageElement) => ({ w: i.naturalWidth, h: i.naturalHeight }));
    expect(upDims.w).toBe(2560);

    // export as WebP from the viewer
    await up.getByTitle("Détails").click();
    await page.getByLabel("Format").selectOption("webp");
    const dl = page.waitForEvent("download");
    await page.locator(".modal").getByRole("link", { name: "Télécharger" }).click();
    expect((await dl).suggestedFilename()).toMatch(/\.webp$/);
    await page.keyboard.press("Escape");
  });

  test("queue: cancel, retry, failure with error, live statuses in History", async ({ page }) => {
    await signIn(page);
    await page.goto("/video");
    await page.getByPlaceholder(/Décris la scène/).fill("Slow night street #slow");
    await page.getByRole("button", { name: /GENERATE/ }).click();
    const card = page.locator(".job-card").first();
    await expect(card.getByRole("button", { name: "Annuler" })).toBeVisible();
    await card.getByRole("button", { name: "Annuler" }).click();
    await expect(card).toHaveAttribute("data-status", "cancelled");
    await card.getByRole("button", { name: "Retry" }).click();
    await expect(card).toHaveAttribute("data-status", "completed", { timeout: 90_000 });

    await page.getByPlaceholder(/Décris la scène/).fill("This one must fail #fail");
    await page.getByRole("button", { name: /GENERATE/ }).click();
    const failed = page.locator(".job-card").first();
    await expect(failed).toHaveAttribute("data-status", "failed", { timeout: 60_000 });
    await expect(failed.locator(".job-error")).toBeVisible();

    await page.goto("/history");
    await expect(page.locator("tr[data-job]")).not.toHaveCount(0);
    await page.getByRole("radio", { name: "Échecs" }).click();
    await expect(page.locator("tr[data-job]")).toHaveCount(1);
    await page.getByRole("radio", { name: "Tous statuts" }).click();
    await page.getByLabel("Recherche").fill("rooftop");
    await expect(page.locator("tr[data-job]")).toHaveCount(1);
    await page.getByLabel("Recherche").fill("");
    await shot(page, "11-history");
    await page.locator("tr[data-job]").first().click();
    await page.getByRole("radio", { name: "Logs" }).click();
    await expect(page.locator(".modal")).toContainText("Routed to NX Mock Video");
  });

  test("presets, first/last frame, video to video, models and admin", async ({ page }) => {
    await signIn(page);
    await page.goto("/video");
    await page.getByRole("button", { name: "Cinematic Drone" }).click();
    await expect(page.getByRole("button", { name: "Drone", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Sauver" }).click();
    await page.getByPlaceholder("ex. DJ Promo Carolina").fill("Mon drone 9:16");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByRole("button", { name: "Mon drone 9:16" })).toBeVisible();

    await page.getByRole("tab", { name: "First / Last Frame" }).click();
    for (const slot of ["Première image", "Dernière image"]) {
      await page.locator(".slot", { hasText: slot }).getByRole("button", { name: "Bibliothèque" }).click();
      await page.locator(".modal .media-tile").first().click();
    }
    await page.getByRole("button", { name: /GENERATE/ }).click();
    await newestCardCompletes(page);

    await page.getByRole("tab", { name: "Video to Video" }).click();
    await page.locator(".slot input[type=file]").first().setInputFiles(path.join(FIX, "clip.mp4"));
    await expect(page.locator(".slot.filled video")).toBeVisible();
    await page.getByPlaceholder(/nouveau style/).fill("anime style");
    await page.getByRole("button", { name: /GENERATE/ }).click();
    await newestCardCompletes(page);
    await shot(page, "12-v2v");

    await page.goto("/models");
    await expect(page.locator("[data-provider=mock-video]")).toContainText("Disponible");
    await shot(page, "13-models");
    await page.goto("/settings?tab=providers");
    await page.locator("[data-provider=mock-video]").getByRole("button", { name: "Tester" }).click();
    await expect(page.locator("[data-test-result=mock-video]")).toContainText("OK");
    await page.goto("/settings?tab=overview");
    await expect(page.locator(".stat").first()).toBeVisible();
    const html = await page.content();
    expect(html).not.toMatch(/SECRET_ACCESS_KEY":"[^e]/);
    await shot(page, "14-admin");
  });
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile, "mobile flow");

  test("phone: every page fits, and a 10 s 9:16 video can be generated from a library image", async ({ page }) => {
    await signIn(page);
    for (const [url, name] of [["/", "generate"], ["/image", "image"], ["/video", "video"], ["/library", "library"], ["/history", "history"], ["/projects", "projects"], ["/models", "models"], ["/settings", "settings"]] as const) {
      await page.goto(url);
      await expect(page.locator(".topbar h1")).toBeVisible();
      await expect(page.locator(".mobile-nav")).toBeVisible();
      await page.waitForTimeout(300);
      await noHorizontalScroll(page);
      await shot(page, `m-${name}`);
    }
    await page.goto("/library");
    await page.getByRole("radio", { name: "Images" }).click();
    await page.locator(".media-tile").first().click();
    await page.getByRole("button", { name: /Animate/ }).first().click();
    await expect(page).toHaveURL(/\/video/);
    await expect(page.locator(".slot.filled img")).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByPlaceholder(/Décris le mouvement/).fill("Slow push in, hair moving in the wind");
    await page.getByRole("radio", { name: "10 s" }).click();
    await page.getByRole("radio", { name: "9:16" }).click();
    await page.getByRole("button", { name: "Dolly In", exact: true }).click();
    await page.getByRole("button", { name: /GENERATE/ }).click();
    await shot(page, "m-generating");
    const card = page.locator(".job-card").first();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute("data-status", "completed", { timeout: 90_000 });
    await noHorizontalScroll(page);
    await shot(page, "m-video-done");
  });
});
