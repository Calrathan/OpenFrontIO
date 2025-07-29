import { Theme } from "../../../../core/configuration/Config";
import { GameView, PlayerView } from "../../../../core/game/GameView";
import { GpuData } from "../DataInterfaces";
import { TextureData } from "../TextureData";
import { UniformValue } from "../UniformSetter";

const MAX_UNIQUE_PLAYER_COLORS = 1 << 12;
const PALETTE_TEXTURE_HEIGHT = 6; // Get this from a list of the colors going into the palette

export class ColorPalette implements GpuData {
  private game: GameView;
  public uniforms: Record<string, UniformValue> = {};

  // Keep track of when the palette may change
  private needsGpuUpload: boolean = false;
  private previousTheme: Theme;
  private previousPlayerCount: number;
  public textureData: TextureData | null = null;

  private currentTheme(): Theme {
    return this.game.config().theme();
  }
  private currentPlayerCount(): number {
    return this.game.playerViews().length;
  }

  init(gl: WebGL2RenderingContext, game: GameView): void {
    this.game = game;
    this.textureData = new TextureData(
      gl,
      MAX_UNIQUE_PLAYER_COLORS,
      PALETTE_TEXTURE_HEIGHT,
      4,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
    );
    this.updateCpuData();
  }

  needsCpuUpdate(): boolean {
    // Dirty checking
    if (
      this.currentTheme() === this.previousTheme &&
      this.currentPlayerCount() === this.previousPlayerCount
    ) {
      return false;
    }
    return true;
  }

  // Updates the palette image when the palette changes.
  updateCpuData(): void {
    if (this.game === null) return;
    if (this.textureData === null) return;
    if (!this.needsCpuUpdate()) return;
    const theme = (this.previousTheme = this.currentTheme());
    const playerCount = (this.previousPlayerCount = this.currentPlayerCount());

    console.log(
      `Updating palette image with player count: ${this.previousPlayerCount}`,
    );
    const width = this.textureData.width; // maximum owner bits for terrain ownership
    const height = this.textureData.height; // variations of color for player
    const bytes = this.textureData.bytes;

    const players = this.game.playerViews();
    const maxSmallId = players.reduce((max, player) => {
      return Math.max(max, player.smallID());
    }, 0);

    const bpp = 4; // bytes per pixel
    const stride = width * bpp; // one row of pixels (for non-power of two textures, may not match width * bpp)
    const paletteMaxColor = Math.min(width, maxSmallId); // Only fill the palette with the colors of the players that exist

    // Offsets for the start of each row of the palette texture
    const row_player_color = 0 * stride;
    const row_building_color = 1 * stride;
    const row_railroad = 2 * stride;
    const row_border_undefended = 3 * stride;
    const row_border_defended_light = 4 * stride;
    const row_border_defended_dark = 5 * stride;

    // Cache all palette colors parameterized by player
    for (let smallId = 1; smallId <= paletteMaxColor; smallId++) {
      const x = smallId;
      const player = this.game.playerBySmallID(smallId) as PlayerView;

      const territoryColor = theme.territoryColor(player);
      const specialBuildingColor = theme.specialBuildingColor(player);
      const railroadColor = theme.railroadColor(player);
      const borderColor = theme.borderColor(player);
      const defendedBorderColors = theme.defendedBorderColors(player);

      // Update an entire column at once.  Cache unfriendly if we get too tall, but fine for now.
      bytes[row_player_color + x * bpp + 0] = territoryColor.rgba.r;
      bytes[row_player_color + x * bpp + 1] = territoryColor.rgba.g;
      bytes[row_player_color + x * bpp + 2] = territoryColor.rgba.b;
      bytes[row_player_color + x * bpp + 3] = territoryColor.rgba.a;

      bytes[row_building_color + x * bpp + 0] = specialBuildingColor.rgba.r;
      bytes[row_building_color + x * bpp + 1] = specialBuildingColor.rgba.g;
      bytes[row_building_color + x * bpp + 2] = specialBuildingColor.rgba.b;
      bytes[row_building_color + x * bpp + 3] = specialBuildingColor.rgba.a;

      bytes[row_railroad + x * bpp + 0] = railroadColor.rgba.r;
      bytes[row_railroad + x * bpp + 1] = railroadColor.rgba.g;
      bytes[row_railroad + x * bpp + 2] = railroadColor.rgba.b;
      bytes[row_railroad + x * bpp + 3] = railroadColor.rgba.a;

      bytes[row_border_undefended + x * bpp + 0] = borderColor.rgba.r;
      bytes[row_border_undefended + x * bpp + 1] = borderColor.rgba.g;
      bytes[row_border_undefended + x * bpp + 2] = borderColor.rgba.b;
      bytes[row_border_undefended + x * bpp + 3] = borderColor.rgba.a;

      bytes[row_border_defended_light + x * bpp + 0] =
        defendedBorderColors.light.rgba.r;
      bytes[row_border_defended_light + x * bpp + 1] =
        defendedBorderColors.light.rgba.g;
      bytes[row_border_defended_light + x * bpp + 2] =
        defendedBorderColors.light.rgba.b;
      bytes[row_border_defended_light + x * bpp + 3] =
        defendedBorderColors.light.rgba.a;

      bytes[row_border_defended_dark + x * bpp + 0] =
        defendedBorderColors.dark.rgba.r;
      bytes[row_border_defended_dark + x * bpp + 1] =
        defendedBorderColors.dark.rgba.g;
      bytes[row_border_defended_dark + x * bpp + 2] =
        defendedBorderColors.dark.rgba.b;
      bytes[row_border_defended_dark + x * bpp + 3] =
        defendedBorderColors.dark.rgba.a;
    }

    this.uniforms["u_borderAlpha"] = 255.0 / 255.0;
    this.uniforms["u_territoryAlpha"] = 150.0 / 255.0;
    this.uniforms["u_focusedBorderColor"] = theme.focusedBorderColor();
    this.uniforms["u_falloutColor"] = theme.falloutColor();

    // Currently not used - uncomment in shader and here if needed
    //this.uniforms["u_spawnHighlightColor"] = theme.spawnHighlightColor();
    //this.uniforms["u_selfColor"] = theme.selfColor();
    //this.uniforms["u_allyColor"] = theme.allyColor();
    //this.uniforms["u_enemyColor"] = theme.enemyColor();

    this.needsGpuUpload = true;
  }

  uploadToGpu(gl: WebGL2RenderingContext): void {
    if (!this.needsGpuUpload) return;

    this.textureData?.uploadChangesToGpu();
  }
  dispose() {
    this.textureData?.dispose();
    this.textureData = null;
  }
}
