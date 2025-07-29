import { Colord, RgbaColor } from "colord";
import { WebGLUtils } from "./WebGLUtils";

// CPU generated texture data to send to the GPU
export class TextureData {
  private gl: WebGLRenderingContext | WebGL2RenderingContext;
  public gpuTexture: WebGLTexture | null = null;

  public readonly width: number;
  public readonly height: number;
  public readonly bpp: number; // bytes per pixel
  public readonly stride: number; // bytes per row (for non-power of two textures, may not match width * bpp)
  public bytes: ArrayBufferLike;
  public readonly format: GLenum; // Texture format
  public readonly internalFormat: GLenum; // Internal texture format
  public readonly datatype: GLenum; // Data type

  constructor(
    gl: WebGL2RenderingContext,
    width: number,
    height: number,
    bpp: number,
    internalFormat: GLenum,
    format: GLenum,
    datatype: GLenum,
    bytes: ArrayBufferLike | null = null,
  ) {
    this.gl = gl;

    this.internalFormat = internalFormat;
    this.format = format;
    this.datatype = datatype;
    this.width = width;
    this.height = height;
    this.bpp = bpp;
    this.stride = this.bpp * this.width;

    const totalBytes = height * this.stride;
    if (datatype === gl.UNSIGNED_SHORT) {
      this.bytes = new Uint16Array(totalBytes);
    } else {
      this.bytes = new Uint8Array(totalBytes);
    }
  }

  public dispose() {
    if (this.gpuTexture) {
      this.gl.deleteTexture(this.gpuTexture);
    }
    this.gpuTexture = null;
  }

  public getRowIndex(row: number): number {
    return row * this.stride[0];
  }

  public setRow(row: number, data: Uint8Array) {
    this.setBytes(data, this.getRowIndex(row));
  }

  public setPixelBytes(x: number, y: number, bytes: Uint8Array) {
    const index = this.getRowIndex(y) + x * this.bpp;
    this.setBytes(bytes, index);
  }
  public setBytes(bytes: Uint8Array | Uint16Array, offset: number = 0) {
    if (bytes instanceof Uint8Array && this.bytes instanceof Uint8Array) {
      this.bytes.set(bytes, 0);
    } else if (
      bytes instanceof Uint16Array &&
      this.bytes instanceof Uint16Array
    ) {
      this.bytes.set(bytes, 0);
    } else {
      throw new Error(
        `Incompatible bytes type: ${this.bytes.constructor.name} and ${bytes.constructor.name}`,
      );
    }
  }

  // Sets the pixel at (x, y) to the given rgba color. Note that this is
  // inefficient for bulk operations; prefer setRow
  public setPixelRgba(x: number, y: number, rgba: RgbaColor) {
    const index = this.getRowIndex(y) + x * this.bpp;
    this.bytes[index + 0] = rgba.r;
    this.bytes[index + 1] = rgba.g;
    this.bytes[index + 2] = rgba.b;
    this.bytes[index + 3] = rgba.a;
  }

  // Sets the pixel at (x, y) to the given rgba color. Note that this is
  // inefficient for bulk operations; prefer setRow
  public setPixelColord(x: number, y: number, color: Colord) {
    this.setPixelRgba(x, y, color.rgba);
  }

  public bindToTextureUnit(unit: number) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.gpuTexture);
  }

  public uploadChangesToGpu() {
    const gl = this.gl;
    if (!this.gpuTexture) {
      if (this.bytes instanceof Uint8Array) {
        this.gpuTexture = WebGLUtils.createTexture(
          this.gl,
          this.width,
          this.height,
          this.bytes as Uint8Array,
          this.internalFormat,
          this.format,
          this.datatype,
        );
      } else if (this.bytes instanceof Uint16Array) {
        this.gpuTexture = WebGLUtils.createTexture(
          this.gl,
          this.width,
          this.height,
          this.bytes as Uint16Array,
          this.internalFormat,
          this.format,
          this.datatype,
        );
      } else {
        throw new Error(
          `Unsupported bytes type: ${this.bytes.constructor.name}`,
        );
      }
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.gpuTexture);
      if (this.bytes instanceof Uint8Array) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          this.internalFormat,
          this.width,
          this.height,
          0,
          this.format,
          this.datatype,
          this.bytes,
        );
      } else if (this.bytes instanceof Uint16Array) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          this.internalFormat,
          this.width,
          this.height,
          0,
          this.format,
          this.datatype,
          this.bytes,
        );
      } else {
        throw new Error(
          `Unsupported bytes type: ${this.bytes.constructor.name}`,
        );
      }
    }
  }
}
