import { PriorityQueue } from "@datastructures-js/priority-queue";
import { Colord } from "colord";
import { Theme } from "../../../core/configuration/Config";
import { EventBus } from "../../../core/EventBus";
import { PlayerType } from "../../../core/game/Game";
import { euclDistFN, TileRef } from "../../../core/game/GameMap";
import { GameUpdateType } from "../../../core/game/GameUpdates";
import { GameView, PlayerView } from "../../../core/game/GameView";
import { UserSettings } from "../../../core/game/UserSettings";
import { AlternateViewEvent } from "../../InputHandler";
import { TransformHandler } from "../TransformHandler";
import { ColorPalette } from "../webgl/data/ColorPalette";
import { TextureData } from "../webgl/TextureData";
import { UniformSetter, UniformValue } from "../webgl/UniformSetter";
import { WebGLUtils } from "../webgl/WebGLUtils";
import { Layer } from "./Layer";

export class WebGLTerritoryLayer implements Layer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private theme: Theme;

  private needsRedraw = false;

  private userSettings: UserSettings;
  private paletteTextureData: TextureData | null = null;
  private tileTextureData: TextureData | null = null;

  //
  // CPU copy of GPU data
  //
  private colorPalette: ColorPalette | null = null;

  private uniforms: {
    sampler: Record<string, number>;
    ui: Record<string, UniformValue>;
    debug: Record<string, UniformValue>;
  } = { sampler: {}, ui: {}, debug: {} };

  //
  // GPU helpers
  //
  private uniformSetter: UniformSetter | null = null;

  private tileToRenderQueue: PriorityQueue<{
    tile: TileRef;
    lastUpdate: number;
  }> = new PriorityQueue((a, b) => {
    return a.lastUpdate - b.lastUpdate;
  });

  // Used for spawn highlighting
  private highlightCanvas: HTMLCanvasElement;
  private highlightContext: CanvasRenderingContext2D;

  private alternativeView = false;
  private lastDragTime = 0;
  private nodrawDragDuration = 200;

  private refreshRate = 10; // refresh every 10ms
  private lastRefresh = 0;

  private lastFocusedPlayer: PlayerView | null = null;

  private static readonly VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

  private static readonly FRAGMENT_SHADER_SOURCE = `#version 300 es
precision mediump float;
precision mediump usampler2D;  // sampled integers are only 16 bits
precision mediump int;

// uv coordinates for map
in vec2 v_texCoord;

// Output
out vec4 fragColor;

// GPU territory tile data
uniform usampler2D u_tileTexture;

// UI state
uniform float u_hasFocusedPlayer;
uniform int u_focusedPlayerId;

// Color data
uniform sampler2D u_paletteTexture;
uniform float u_territoryAlpha;     // Common alpha for all territory colors
uniform float u_borderAlpha;        // Common alpha for borders
uniform vec3 u_focusedBorderColor;
uniform vec3 u_falloutColor;

// Currently not used - uncomment in uniform declaration and here if needed
//uniform vec3 u_spawnHighlightColor;
//uniform vec3 u_selfColor;
//uniform vec3 u_allyColor;
//uniform vec3 u_enemyColor;

uniform bool debug_draw_palette;
uniform bool debug_draw_tiles;
uniform float debug_draw_cpu_percent;

//
// common shader helper functions
// 

// Fetch unfiltered pixel at u,v
vec4 fetchPixel(sampler2D texture, vec2 uv)
{
  int mipLevel = 0;
  ivec2 textureDims = textureSize(texture, mipLevel);
  ivec2 pixelCoord = ivec2(floor(uv * vec2(textureDims)));
  return texelFetch(texture, pixelCoord, mipLevel);
}

//
// Terrain shading implementation
//

const uint UNOWNED_TERRITORY_ID = 0u;
const uint OWNER_ID_MASK = (1u << 12) - 1u; // all lower 12 bits
const uint FALLOUT_MASK = 1u << 13;
const uint DEFENSE_BONUS_MASK = 1u << 14;

struct TileData {
    uint ownerId;
    bool isFallout;
    bool hasDefenseBonus;
};

// Extract the territory bits into a struct (code cleanliness)
TileData DecodeTileData(uint bits)
{
  TileData result;
  result.ownerId         = (bits & OWNER_ID_MASK);
  result.isFallout       = (bits & FALLOUT_MASK) != 0u;
  result.hasDefenseBonus = (bits & DEFENSE_BONUS_MASK) != 0u;
  return result;
}

// Fetch and Decode the tile data for the current fragment
TileData ThisTile()
{
    uint bits = texture(u_tileTexture, v_texCoord).r;
    return DecodeTileData(bits);
}

vec4 DebugDrawTileData(vec4 inColor)
{
  int debugTileSize = 4;
  ivec2 textureDims = textureSize(u_tileTexture, 0);
  ivec2 pixelCoord = ivec2(floor(v_texCoord * vec2(textureDims)));

  int stipple = ((pixelCoord.y >> debugTileSize) ^ (pixelCoord.x >> debugTileSize)) & 1;

  if (stipple == 0) 
  {
    TileData tileData = ThisTile();
    vec4 debugColor = vec4(
      float(tileData.ownerId)/255.0, 
      tileData.isFallout ? 1.0f : 0.0f, 
      tileData.hasDefenseBonus ? 1.0f : 0.0f, 1.0);
    return mix(inColor, debugColor, 0.5);
  }
  
  return inColor;
}
  
// Check if a pixel is a border by comparing with neighbors
bool isBorder(vec2 uv, uint ownerId) 
{
  int mipLevel = 0;
  ivec2 textureDims = textureSize(u_tileTexture, mipLevel);
  ivec2 texel_xy = ivec2(floor(uv * vec2(textureDims)));

  uvec4 neighbors;
  neighbors[0] = texelFetch(u_tileTexture, texel_xy + ivec2(-1, 0), mipLevel).r & OWNER_ID_MASK;
  neighbors[1] = texelFetch(u_tileTexture, texel_xy + ivec2(+1, 0), mipLevel).r & OWNER_ID_MASK;
  neighbors[2] = texelFetch(u_tileTexture, texel_xy + ivec2(0, -1), mipLevel).r & OWNER_ID_MASK;
  neighbors[3] = texelFetch(u_tileTexture, texel_xy + ivec2(0, +1), mipLevel).r & OWNER_ID_MASK;

  bvec4 matches;
  matches[0] = (neighbors[0] == ownerId); 
  matches[1] = (neighbors[1] == ownerId);
  matches[2] = (neighbors[2] == ownerId);
  matches[3] = (neighbors[3] == ownerId);

  return !all(matches);
}

//
// LUT for player specific colors
//
const uint PLAYER_COLOR_TERRITORY                  = 0u;
const uint PLAYER_COLOR_TEAM                       = 1u;
const uint PLAYER_COLOR_BORDER                     = 3u;
const uint PLAYER_COLOR_DEFENSE_BONUS_BORDER_LIGHT = 4u;
const uint PLAYER_COLOR_DEFENSE_BONUS_BORDER_DARK  = 5u;

// Sample the player palette buffer
vec4 getPlayerColor(uint ownerId, uint row)
{
  int mipLevel = 0;
  ivec2 pixelCoord = ivec2(ownerId, row);
  vec4 paletteColor = texelFetch(u_paletteTexture, pixelCoord, mipLevel);
  float alpha = (row >= PLAYER_COLOR_BORDER) ? u_borderAlpha : u_territoryAlpha;
  return vec4(paletteColor.rgb, alpha);
}

vec4 calculateDefendedBorderColor(uint ownerId, vec2 uv) 
{ 
    int mipmapLevel = 0;
    ivec2 textureDimensions = textureSize(u_tileTexture, mipmapLevel);
    ivec2 pixelCoord = ivec2(floor(uv * vec2(textureDimensions)));

    int stipple = (pixelCoord.y ^ pixelCoord.x) & 1;
    uint paletteRow = (stipple == 0) ? 
        PLAYER_COLOR_DEFENSE_BONUS_BORDER_LIGHT :
        PLAYER_COLOR_DEFENSE_BONUS_BORDER_DARK;

  return getPlayerColor(ownerId, paletteRow); 
}

vec4 calculateBorderColor(TileData tileData, vec2 uv)
{
  if (u_hasFocusedPlayer > 0.0f && tileData.ownerId == uint(u_focusedPlayerId)) 
  {
    return vec4(u_focusedBorderColor, u_territoryAlpha);
  } 
  else if (tileData.hasDefenseBonus)
  {
    return calculateDefendedBorderColor(tileData.ownerId, uv);
  }
  else
  {
    return getPlayerColor(tileData.ownerId, PLAYER_COLOR_BORDER);
  }
}

 
//
// GPU based tile color shading
//

vec4 territoryColor()
{
    vec4 result;
    TileData thisTile = ThisTile();
    
    if (thisTile.isFallout)
    {
      result = vec4(u_falloutColor.rgb, u_territoryAlpha);
    }
    else if (thisTile.ownerId == UNOWNED_TERRITORY_ID)
    {
      result = vec4(0.0);
    }
    else if (isBorder(v_texCoord, thisTile.ownerId))
    {
      result = calculateBorderColor(thisTile, v_texCoord);
    }
    else
    {
        result = getPlayerColor(thisTile.ownerId, PLAYER_COLOR_TERRITORY);
    }

    if (debug_draw_tiles)
    {
      result = DebugDrawTileData(result);
    }
    return result;
}

//
// Debug visualizations of input data
//
vec4 DebugDrawPalette(vec4 inColor, vec2 offset)
{
  int mipLevel = 0;
  int debugTileSize = 1;
  ivec2 textureDims = textureSize(u_tileTexture, mipLevel);
  ivec2 pixelCoord = ivec2(floor(v_texCoord * vec2(textureDims)));
  ivec2 paletteTextureDims = textureSize(u_paletteTexture, mipLevel);
  pixelCoord.x >>= debugTileSize;
  pixelCoord.y >>= debugTileSize; 

  if (any(lessThan(pixelCoord, ivec2(0, 0))) || any(greaterThanEqual(pixelCoord, paletteTextureDims)))
    return inColor;

  vec3 paletteColor = texelFetch(u_paletteTexture, pixelCoord, mipLevel).rgb;
  return vec4(paletteColor, 1.0);
}


ivec2 fragmentCoordinates()
{
  int mipLevel = 0;
  ivec2 textureDimensions = textureSize(u_tileTexture, mipLevel);
  ivec2 pixelCoord = ivec2(floor(v_texCoord * vec2(textureDimensions)));
  return pixelCoord;
}

void main() 
{
  fragColor = territoryColor();

  // Composite debug layers on top
  if (debug_draw_palette)
  {
    fragColor = DebugDrawPalette(fragColor, vec2(0.0, 0.0));
  }
}
`;

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private transformHandler: TransformHandler,
    userSettings: UserSettings,
  ) {
    this.userSettings = userSettings;
    this.theme = game.config().theme();
    this.canvas = document.createElement("canvas");

    // Initialize highlight canvas
    this.highlightCanvas = document.createElement("canvas");
    const highlightContext = this.highlightCanvas.getContext("2d", {
      alpha: true,
    });
    if (highlightContext === null) throw new Error("2d context not supported");
    this.highlightContext = highlightContext;
  }

  shouldTransform(): boolean {
    return true;
  }

  paintHighlightTile(tile: TileRef, color: Colord, alpha: number) {
    const x = this.game.x(tile);
    const y = this.game.y(tile);
    this.highlightContext.fillStyle = color.alpha(alpha / 255).toRgbString();
    this.highlightContext.fillRect(x, y, 1, 1);
  }

  paintHighlightLayer() {
    if (!this.game.inSpawnPhase()) return;
    if (this.game.ticks() % 5 === 0) return;

    this.highlightContext.clearRect(
      0,
      0,
      this.game.width(),
      this.game.height(),
    );

    const humans = this.game
      .playerViews()
      .filter((p) => p.type() === PlayerType.Human);

    for (const human of humans) {
      const center = human.nameLocation();
      if (!center) {
        continue;
      }
      const centerTile = this.game.ref(center.x, center.y);
      if (!centerTile) {
        continue;
      }
      let color = this.theme.spawnHighlightColor();
      const myPlayer = this.game.myPlayer();
      if (
        myPlayer !== null &&
        myPlayer !== human &&
        myPlayer.isFriendly(human)
      ) {
        color = this.theme.selfColor();
      }
      for (const tile of this.game.bfs(
        centerTile,
        euclDistFN(centerTile, 9, true),
      )) {
        if (!this.game.hasOwner(tile)) {
          this.paintHighlightTile(tile, color, 255);
        }
      }
    }
  }

  publishGameUpdates() {
    const updates = this.game.updatesSinceLastTick();

    // TODO - publish recently updated tiles to the GPU as buffer data for scatter-write
    const tileUpdates = updates?.[GameUpdateType.Tile] ?? [];
    const unitUpdates = updates?.[GameUpdateType.Unit] ?? [];
  }

  tick() {
    this.publishGameUpdates();
    this.paintHighlightLayer();
  }

  init() {
    this.eventBus.on(
      AlternateViewEvent,
      (e) => (this.alternativeView = e.alternateView),
    );

    // TODO: consider re-enabling this on mobile or low end devices for smoother dragging.
    // this.eventBus.on(DragEvent, (e) =>
    //   this.lastDragTime = Date.now());

    if (this.initWebGL()) {
      this.redraw();
    }
  }

  redraw() {
    // Set up highlight canvas dimensions
    this.highlightCanvas.width = this.game.width();
    this.highlightCanvas.height = this.game.height();
    this.needsRedraw = true;
  }

  stageAllGpuData() {
    this.colorPalette?.updateCpuData();
    this.updateTileTextureData();

    const focusedPlayer = this.game.focusedPlayer();
    this.uniforms.ui["u_hasFocusedPlayer"] = focusedPlayer ? 1.0 : 0.0;
    this.uniforms.ui["u_focusedPlayerId"] = focusedPlayer?.smallID() ?? 0;
  }

  uploadAllDataToGPU() {
    if (!this.gl) return;
    // Initialize texture data and render all territories
    this.colorPalette?.uploadToGpu(this.gl);
    this.tileTextureData?.uploadChangesToGpu();
  }

  renderLayer(context: CanvasRenderingContext2D) {
    if (this.alternativeView) return;
    const now = Date.now();
    if (
      now > this.lastDragTime + this.nodrawDragDuration &&
      now > this.lastRefresh + this.refreshRate
    ) {
      this.stageAllGpuData();
      this.uploadAllDataToGPU();
      this.renderToCanvas();
      this.lastRefresh = now;
      console.log("🎨 renderLayer - Stage and upload");
    }

    context.drawImage(
      this.canvas,
      -this.game.width() / 2,
      -this.game.height() / 2,
      this.game.width(),
      this.game.height(),
    );

    if (this.game.inSpawnPhase()) {
      context.drawImage(
        this.highlightCanvas,
        -this.game.width() / 2,
        -this.game.height() / 2,
        this.game.width(),
        this.game.height(),
      );
    }
  }

  private initWebGL(): boolean {
    this.canvas.width = this.game.width();
    this.canvas.height = this.game.height();

    const gl = (this.gl = this.canvas.getContext(
      "webgl2",
    ) as WebGL2RenderingContext);
    if (!this.gl) {
      console.error("Failed to get WebGL context");
      return false;
    }
    const game = this.game;
    const [width, height] = [game.width(), game.height()];

    const program = (this.program = WebGLTerritoryLayer.createProgram(gl));
    const vertexBuffer = (this.vertexBuffer =
      WebGLTerritoryLayer.createVertexBuffer(gl));
    this.uniformSetter = WebGLTerritoryLayer.bindProgram(
      gl,
      this.program,
      vertexBuffer,
    );
    this.tileTextureData = WebGLTerritoryLayer.createTileTexture(
      gl,
      width,
      height,
    );
    this.colorPalette = WebGLTerritoryLayer.createColorPalette(gl, game);

    // Initialize constant shader uniform parameters
    this.uniforms.sampler["u_paletteTexture"] = 0;
    this.uniforms.sampler["u_tileTexture"] = 1;

    this.uniforms.debug["debug_draw_palette"] = true;
    this.uniforms.debug["debug_draw_tiles"] = false;
    this.uniforms.debug["debug_draw_cpu_percent"] = 0.75;

    return true;
  }

  private static createProgram(gl: WebGL2RenderingContext): WebGLProgram {
    const vertexShader = WebGLUtils.createShader(
      gl,
      gl.VERTEX_SHADER,
      WebGLTerritoryLayer.VERTEX_SHADER_SOURCE,
    );
    const fragmentShader = WebGLUtils.createShader(
      gl,
      gl.FRAGMENT_SHADER,
      WebGLTerritoryLayer.FRAGMENT_SHADER_SOURCE,
    );

    if (!vertexShader || !fragmentShader) {
      console.error("Failed to create shaders");
      return false;
    }

    // Create program
    const program = WebGLUtils.createProgram(gl, vertexShader, fragmentShader);
    if (!program) {
      throw new Error("Failed to create shader program");
    }
    return program;
  }

  private static createColorPalette(
    gl: WebGL2RenderingContext,
    game: GameView,
  ) {
    const colorPalette = new ColorPalette();
    colorPalette.init(gl, game);
    return colorPalette;
  }

  private static createVertexBuffer(gl: WebGL2RenderingContext): WebGLBuffer {
    // Format: [x, y, u, v] for each vertex
    const vertexData = new Float32Array([
      // Position    // Texture coords
      -1.0,
      -1.0,
      0.0,
      1.0, // Bottom left
      +1.0,
      -1.0,
      1.0,
      1.0, // Bottom right
      -1.0,
      +1.0,
      0.0,
      0.0, // Top left
      +1.0,
      +1.0,
      1.0,
      0.0, // Top right
    ]);

    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW);
    return vertexBuffer;
  }

  private static bindProgram(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    vertexBuffer: WebGLBuffer,
  ): UniformSetter {
    const positionAttributeLocation = gl.getAttribLocation(
      program,
      "a_position",
    );
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.vertexAttribPointer(
      positionAttributeLocation,
      2, // 2 components per vertex (x, y)
      gl.FLOAT,
      false,
      4 * 4, // stride: 4 floats * 4 bytes per float
      0, // offset: start at beginning
    );

    // Set up texture coordinate attribute
    const texCoordAttributeLocation = gl.getAttribLocation(
      program,
      "a_texCoord",
    );
    gl.enableVertexAttribArray(texCoordAttributeLocation);
    gl.vertexAttribPointer(
      texCoordAttributeLocation,
      2, // 2 components per vertex (u, v)
      gl.FLOAT,
      false,
      4 * 4, // stride: 4 floats * 4 bytes per float
      2 * 4, // offset: skip 2 floats (x, y) to get to texture coords
    );
    return new UniformSetter(gl, program);
  }

  private static createTileTexture(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
  ): TextureData {
    return new TextureData(
      gl,
      width,
      height,
      2,
      gl.R16UI,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
    );
  }

  private updateTileTextureData() {
    if (!this.tileTextureData) return;
    const ownerBuffer = (this.game as GameView).ownerBuffer();
    const ownerBufferView = ownerBuffer.subarray(0, ownerBuffer.length);
    this.tileTextureData.bytes = ownerBufferView;
  }

  private renderToCanvas(): void {
    if (!this.gl) return;
    if (!this.program) return;
    if (!this.uniformSetter) return;
    if (!this.colorPalette) return;

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    // Enable blending for transparency
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.useProgram(this.program);

    this.colorPalette.textureData!.bindToTextureUnit(
      this.uniforms.sampler["u_paletteTexture"],
    );
    this.tileTextureData!.bindToTextureUnit(
      this.uniforms.sampler["u_tileTexture"],
    );

    // Upload all uniform parameters
    this.uniformSetter.set(this.colorPalette!.uniforms);
    this.uniformSetter.set(this.uniforms.sampler);
    this.uniformSetter.set(this.uniforms.ui);
    this.uniformSetter.set(this.uniforms.debug);

    // Draw the textured quad
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  private renderGpuOnly = false;

  dispose() {
    if (!this.gl) {
      return;
    }

    if (this.vertexBuffer) {
      this.gl.deleteBuffer(this.vertexBuffer);
      this.vertexBuffer = null;
    }

    if (this.program) {
      this.gl.deleteProgram(this.program);
      this.program = null;
    }

    this.colorPalette?.dispose();
    this.colorPalette = null;

    this.paletteTextureData = null;
    this.tileTextureData?.dispose();
    this.tileTextureData = null;

    this.uniformSetter?.dispose();
    this.uniformSetter = null;

    this.gl = null;
  }
}
