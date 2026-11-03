/**
 * Rich Menu setup — the persistent button grid at the bottom of the LINE chat.
 *
 * LINE requires a 2500×1686 PNG/JPEG for a 6-area menu, so this script does
 * not invent an image: you supply one and it wires the tappable areas to the
 * same postback actions the quick replies use.
 *
 *   npm run richmenu -- ./assets/richmenu.png
 *   npm run richmenu -- --list
 *   npm run richmenu -- --delete
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { lineClient } from "./line.js";

const WIDTH = 2500;
const HEIGHT = 1686;
const COLUMN_WIDTH = 833;
const ROW_HEIGHT = HEIGHT / 2; // 843

interface MenuArea {
  x: number;
  y: number;
  width: number;
  height: number;
  data: string;
}

// Matches the mode ids used everywhere else (action=mode&value=...).
const AREAS: MenuArea[] = [
  { x: 0, y: 0, width: COLUMN_WIDTH, height: ROW_HEIGHT, data: "action=mode&value=translate" },
  { x: COLUMN_WIDTH, y: 0, width: COLUMN_WIDTH, height: ROW_HEIGHT, data: "action=mode&value=grammar" },
  { x: COLUMN_WIDTH * 2, y: 0, width: WIDTH - COLUMN_WIDTH * 2, height: ROW_HEIGHT, data: "action=mode&value=conversation" },
  { x: 0, y: ROW_HEIGHT, width: COLUMN_WIDTH, height: ROW_HEIGHT, data: "action=mode&value=vocab" },
  { x: COLUMN_WIDTH, y: ROW_HEIGHT, width: COLUMN_WIDTH, height: ROW_HEIGHT, data: "action=mode&value=life" },
  { x: COLUMN_WIDTH * 2, y: ROW_HEIGHT, width: WIDTH - COLUMN_WIDTH * 2, height: ROW_HEIGHT, data: "action=help" },
];

/**
 * Reads width/height straight out of the PNG IHDR chunk. Catches the common
 * mistake of uploading a screenshot at the wrong resolution before LINE
 * rejects it with a less helpful error.
 */
function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8);
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!signature.equals(expected)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function listMenus(): Promise<void> {
  const response = await lineClient.getRichMenuList();
  const menus = response.richmenus ?? [];
  if (menus.length === 0) {
    console.log("No rich menus exist for this channel.");
    return;
  }
  for (const menu of menus) {
    console.log(`${menu.richMenuId}\t${menu.name ?? "(unnamed)"}\t${menu.size?.width}x${menu.size?.height}`);
  }
}

async function deleteAllMenus(): Promise<void> {
  const response = await lineClient.getRichMenuList();
  const menus = response.richmenus ?? [];
  if (menus.length === 0) {
    console.log("Nothing to delete.");
    return;
  }
  for (const menu of menus) {
    await lineClient.deleteRichMenu(menu.richMenuId);
    console.log(`Deleted ${menu.richMenuId} (${menu.name ?? "unnamed"})`);
  }
}

async function installMenu(imagePath: string): Promise<void> {
  const image = await readFile(imagePath);
  const size = readPngSize(image);

  if (!size) {
    throw new Error(`${imagePath} is not a PNG file. LINE accepts PNG or JPEG.`);
  }
  if (size.width !== WIDTH || size.height !== HEIGHT) {
    throw new Error(
      `Expected a ${WIDTH}x${HEIGHT} PNG, got ${size.width}x${size.height}. ` +
        "Resize it before uploading — LINE will reject the wrong size."
    );
  }

  const created = await lineClient.createRichMenu({
    size: { width: WIDTH, height: HEIGHT },
    selected: false,
    name: "Nihongo Companion main menu",
    chatBarText: "メニュー",
    areas: AREAS.map((area) => ({
      bounds: { x: area.x, y: area.y, width: area.width, height: area.height },
      action: { type: "postback", data: area.data },
    })),
  });

  console.log(`Created rich menu ${created.richMenuId}`);

  await lineClient.setRichMenuImage(
    created.richMenuId,
    new Blob([new Uint8Array(image)], { type: "image/png" })
  );
  console.log("Uploaded image");

  await lineClient.setDefaultRichMenu(created.richMenuId);
  console.log("Set as the default menu for all users");
}

async function main(): Promise<void> {
  const argument = process.argv[2];

  if (!argument) {
    console.error(
      "Usage:\n" +
        "  npm run richmenu -- ./assets/richmenu.png   install\n" +
        "  npm run richmenu -- --list                 list menus\n" +
        "  npm run richmenu -- --delete               delete all menus\n\n" +
        `The image must be a ${WIDTH}x${HEIGHT} PNG (or 2500x843 for a 3-area menu).`
    );
    process.exit(1);
  }

  if (argument === "--list") {
    await listMenus();
    return;
  }

  if (argument === "--delete") {
    await deleteAllMenus();
    return;
  }

  await installMenu(argument);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
