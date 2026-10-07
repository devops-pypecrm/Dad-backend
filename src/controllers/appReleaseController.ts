import { Request, Response } from "express";
import prisma from "../config/prisma";
import path from "path";

/**
 * App-distribution version manifest, backed by the generic `SystemSetting`
 * key/value table rather than a dedicated model — this is just two small
 * JSON blobs (one per platform), not queryable relational data, so a new
 * table/migration would be overkill. `SystemSetting.value` is a plain
 * `String` column, so each blob is stored JSON-stringified.
 */
const PLATFORMS = ["mobile", "helper", "dialer"] as const;
type Platform = (typeof PLATFORMS)[number];

const settingKey = (platform: Platform) => `app_release_${platform}`;

interface ReleaseManifest {
  versionName: string;
  versionCode: number;
  releaseNotes: string;
  apkFileName: string;
  releasedAt: string;
}

function isValidPlatform(value: unknown): value is Platform {
  return (
    typeof value === "string" &&
    (PLATFORMS as readonly string[]).includes(value)
  );
}

// GET /api/app-releases/latest?platform=mobile|helper
export const getLatestRelease = async (req: Request, res: Response) => {
  try {
    const platform = req.query.platform;
    if (!isValidPlatform(platform)) {
      return res
        .status(400)
        .json({ message: `platform must be one of: ${PLATFORMS.join(", ")}` });
    }

    const setting = await prisma.systemSetting.findUnique({
      where: { key: settingKey(platform) },
    });
    if (!setting) {
      return res.status(404).json({
        message: `No release published yet for platform "${platform}"`,
      });
    }

    const manifest = JSON.parse(setting.value) as ReleaseManifest;
    res.json(manifest);
  } catch (error) {
    console.error("[AppReleaseController] getLatestRelease error:", error);
    res.status(500).json({ message: "Failed to fetch latest release" });
  }
};

// GET /api/app-releases/download/:platform — a stable URL that always
// points at whichever file the manifest currently names, so download links
// (in the app's update dialog, the public download page) never need to be
// updated when a new version is published.
export const downloadRelease = async (req: Request, res: Response) => {
  try {
    const platform = req.params.platform;
    if (!isValidPlatform(platform)) {
      return res
        .status(400)
        .json({ message: `platform must be one of: ${PLATFORMS.join(", ")}` });
    }

    const setting = await prisma.systemSetting.findUnique({
      where: { key: settingKey(platform) },
    });
    if (!setting) {
      return res.status(404).json({
        message: `No release published yet for platform "${platform}"`,
      });
    }

    const manifest = JSON.parse(setting.value) as ReleaseManifest;
    const filePath = path.join(
      process.cwd(),
      "uploads",
      "releases",
      manifest.apkFileName,
    );

    return res.download(
      filePath,
      manifest.apkFileName,
      {
        headers: {
          "Content-Type": "application/vnd.android.package-archive",
        },
      },
      (error) => {
        if (error) {
          console.error("[AppReleaseController] APK download error:", error);

          if (!res.headersSent) {
            res.status(500).json({
              message: "Failed to download APK",
            });
          }
        }
      },
    );
  } catch (error) {
    console.error("[AppReleaseController] downloadRelease error:", error);
    res.status(500).json({ message: "Failed to resolve download" });
  }
};
