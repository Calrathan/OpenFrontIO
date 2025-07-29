import { GameView } from "../../../core/game/GameView";

export interface GpuData {
  init(gl: WebGL2RenderingContext, game: GameView): void;
  needsCpuUpdate(): boolean;
  updateCpuData(): void;
  uploadToGpu(gl: WebGL2RenderingContext): void;
}
