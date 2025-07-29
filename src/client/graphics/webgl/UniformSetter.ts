import { WebGLUtils } from "./WebGLUtils";

// Type definitions for uniform values
export type UniformValue =
  | number
  | boolean
  | Float32Array
  | Int32Array
  | readonly [number, number]
  | readonly [number, number, number]
  | readonly [number, number, number, number]
  | { rgba: { r: number; g: number; b: number; a: number } }; // Colord-like objects

/**
 * Cached uniform setter for efficient binding to a shader program
 */
export class UniformSetter {
  private locationCache = new Map<string, WebGLUniformLocation | null>();
  private uniformInfoCache = new Map<string, WebGLActiveInfo | null>();

  constructor(
    private gl: WebGLRenderingContext | WebGL2RenderingContext,
    private program: WebGLProgram,
  ) {}

  set(uniforms: Record<string, UniformValue>): void {
    this.ensureCorrectProgramBound();
    Object.entries(uniforms).forEach(([name, value]) => {
      const location = this.getLocation(name);
      if (location) {
        const uniformInfo = this.getUniformInfo(name);
        setUniform(this.gl, location, value, uniformInfo, name);
      }
    });
  }

  setOne(name: string, value: UniformValue): void {
    this.ensureCorrectProgramBound();
    const location = this.getLocation(name);
    if (location) {
      const uniformInfo = this.getUniformInfo(name);
      setUniform(this.gl, location, value, uniformInfo, name);
    }
  }

  setInt(name: string, value: number): void {
    this.ensureCorrectProgramBound();
    const location = this.getLocation(name);
    if (location) {
      const uniformInfo = this.getUniformInfo(name);
      setUniform(this.gl, location, value, uniformInfo, name);
    }
  }

  // Explicitly binds this setter's program to the WebGL context
  bindProgram(): void {
    this.gl.useProgram(this.program);
  }

  // Ensures the correct program is bound before setting uniforms
  private ensureCorrectProgramBound(): void {
    const currentProgram = this.gl.getParameter(this.gl.CURRENT_PROGRAM);
    if (currentProgram !== this.program) {
      console.error("Program mismatch detected!");
      console.error(`Expected program:`, this.program);
      console.error(`Currently bound program:`, currentProgram);
      console.error(
        "You need to call gl.useProgram() with the correct program before setting uniforms",
      );

      // Auto-fix by binding the correct program
      console.warn("Auto-binding correct program...");
      this.gl.useProgram(this.program);
    }
  }

  // Caches the location of a uniform in the shader program
  private getLocation(name: string): WebGLUniformLocation | null {
    if (!this.locationCache.has(name)) {
      const location = this.gl.getUniformLocation(this.program, name);
      this.locationCache.set(name, location);
      if (!location) {
        // Debug: List all available uniforms in the program
        const numUniforms = this.gl.getProgramParameter(
          this.program,
          this.gl.ACTIVE_UNIFORMS,
        );
        const availableUniforms: string[] = [];
        for (let i = 0; i < numUniforms; i++) {
          const info = this.gl.getActiveUniform(this.program, i);
          if (info) {
            availableUniforms.push(info.name);
          }
        }
        console.warn(`Uniform '${name}' not found in shader program.`);
      }
    }
    return this.locationCache.get(name) ?? null;
  }

  // Caches the uniform info for a uniform in the shader program
  private getUniformInfo(name: string): WebGLActiveInfo | null {
    if (!this.uniformInfoCache.has(name)) {
      const uniformInfo = WebGLUtils.getUniformInfoByName(
        this.gl,
        this.program,
        name,
      );
      this.uniformInfoCache.set(name, uniformInfo);
    }
    return this.uniformInfoCache.get(name) ?? null;
  }

  clearCache(): void {
    this.locationCache.clear();
    this.uniformInfoCache.clear();
  }

  dispose(): void {
    this.clearCache();
  }
}

// Uploads a uniform value for the bound program
export function setUniform(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  location: WebGLUniformLocation,
  value: UniformValue,
  uniformInfo?: WebGLActiveInfo | null,
  name?: string,
): void {
  try {
    // Debug: Check if any program is bound
    const currentProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    if (!currentProgram) {
      console.error(
        `No program bound when trying to set uniform ${name ?? "unknown"}`,
      );
      return;
    }
    if (value instanceof Float32Array) {
      switch (value.length) {
        case 1:
          gl.uniform1fv(location, value);
          break;
        case 2:
          gl.uniform2fv(location, value);
          break;
        case 3:
          gl.uniform3fv(location, value);
          break;
        case 4:
          gl.uniform4fv(location, value);
          break;
        case 9:
          gl.uniformMatrix3fv(location, false, value);
          break;
        case 16:
          gl.uniformMatrix4fv(location, false, value);
          break;
        default:
          throw new Error(`Unsupported Float32Array length: ${value.length}`);
      }
    } else if (value instanceof Int32Array) {
      switch (value.length) {
        case 1:
          gl.uniform1iv(location, value);
          break;
        case 2:
          gl.uniform2iv(location, value);
          break;
        case 3:
          gl.uniform3iv(location, value);
          break;
        case 4:
          gl.uniform4iv(location, value);
          break;
        default:
          throw new Error(`Unsupported Int32Array length: ${value.length}`);
      }
    } else if (typeof value === "number") {
      // Use introspection to determine if this should be int, uint, or float
      if (uniformInfo) {
        switch (uniformInfo.type) {
          case gl.SAMPLER_2D:
          case gl.SAMPLER_CUBE:
          case gl instanceof WebGL2RenderingContext
            ? (gl as WebGL2RenderingContext).SAMPLER_2D_ARRAY
            : undefined:
          case gl instanceof WebGL2RenderingContext
            ? (gl as WebGL2RenderingContext).UNSIGNED_INT_SAMPLER_2D
            : undefined:
          case gl instanceof WebGL2RenderingContext
            ? (gl as WebGL2RenderingContext).INT_SAMPLER_2D
            : undefined:
            gl.uniform1i(location, Math.floor(value));
            break;
          case gl.FLOAT:
            gl.uniform1f(location, value);
            break;
          case gl.INT:
            gl.uniform1i(location, Math.floor(value));
            break;
          case gl.INT_VEC2:
          case gl.INT_VEC3:
          case gl.INT_VEC4:
            throw new Error(
              `Tried to set a scalar into a vector field: ${uniformInfo.type} ${uniformInfo.name}`,
            );
            break;
          case gl instanceof WebGL2RenderingContext
            ? gl.UNSIGNED_INT
            : undefined:
            (gl as WebGL2RenderingContext).uniform1ui(
              location,
              Math.max(0, Math.floor(value)),
            );
            break;
          case gl.BOOL:
            gl.uniform1i(location, value ? 1 : 0);
            break;
          default:
            break;
        }
      } else {
        // Fallback to float if no introspection available
        gl.uniform1f(location, value);
      }
    } else if (typeof value === "boolean") {
      gl.uniform1i(location, value ? 1 : 0);
    } else if (Array.isArray(value)) {
      // Use introspection to determine if this should be int or float vectors
      if (uniformInfo) {
        switch (uniformInfo.type) {
          case gl.INT_VEC2:
            if (value.length === 2) {
              gl.uniform2i(
                location,
                Math.floor(value[0]),
                Math.floor(value[1]),
              );
            } else {
              throw new Error(
                `Expected 2 values for INT_VEC2, got ${value.length} ${uniformInfo.name}`,
              );
            }
            break;
          case gl.INT_VEC3:
            if (value.length === 3) {
              gl.uniform3i(
                location,
                Math.floor(value[0]),
                Math.floor(value[1]),
                Math.floor(value[2]),
              );
            } else {
              throw new Error(
                `Expected 3 values for INT_VEC3, got ${value.length}`,
              );
            }
            break;
          case gl.INT_VEC4:
            if (value.length === 4) {
              gl.uniform4i(
                location,
                Math.floor(value[0]),
                Math.floor(value[1]),
                Math.floor(value[2]),
                Math.floor(value[3]),
              );
            } else {
              throw new Error(
                `Expected 4 values for INT_VEC4, got ${value.length}`,
              );
            }
            break;
          default:
            // Default to float vectors
            switch (value.length) {
              case 2:
                gl.uniform2f(location, value[0], value[1]);
                break;
              case 3:
                gl.uniform3f(location, value[0], value[1], value[2]);
                break;
              case 4:
                gl.uniform4f(location, value[0], value[1], value[2], value[3]);
                break;
              default:
                throw new Error(`Unsupported array length: ${value.length}`);
            }
            break;
        }
      } else {
        // Fallback to float vectors if no introspection available
        switch (value.length) {
          case 2:
            gl.uniform2f(location, value[0], value[1]);
            break;
          case 3:
            gl.uniform3f(location, value[0], value[1], value[2]);
            break;
          case 4:
            gl.uniform4f(location, value[0], value[1], value[2], value[3]);
            break;
          default:
            throw new Error(`Unsupported array length: ${value.length}`);
        }
      }
    } else if (value && typeof value === "object" && "rgba" in value) {
      // Handle Colord objects and objects with rgba properties using introspection
      const rgba = (value as any).rgba;

      if (uniformInfo) {
        switch (uniformInfo.type) {
          case gl.FLOAT_VEC3:
            // Shader expects vec3 - send RGB only
            gl.uniform3f(
              location,
              rgba.r / 255.0,
              rgba.g / 255.0,
              rgba.b / 255.0,
            );
            break;
          case gl.FLOAT_VEC4:
            // Shader expects vec4 - send RGBA
            const alpha = rgba.a !== undefined ? rgba.a / 255.0 : 1.0;
            gl.uniform4f(
              location,
              rgba.r / 255.0,
              rgba.g / 255.0,
              rgba.b / 255.0,
              alpha,
            );
            break;
          case gl.INT_VEC3:
            // Integer RGB
            gl.uniform3i(location, rgba.r | 0, rgba.g | 0, rgba.b | 0);
            break;
          case gl.INT_VEC4:
            // Integer RGBA
            const alphaInt = rgba.a !== undefined ? rgba.a : 255;
            gl.uniform4i(
              location,
              rgba.r | 0,
              rgba.g | 0,
              rgba.b | 0,
              alphaInt | 0,
            );
            break;
          default:
            // Fallback: assume vec3 for RGB if alpha is 1.0, otherwise vec4
            if (rgba.a === undefined || rgba.a === 1.0 || rgba.a === 255) {
              gl.uniform3f(
                location,
                rgba.r / 255.0,
                rgba.g / 255.0,
                rgba.b / 255.0,
              );
            } else {
              gl.uniform4f(
                location,
                rgba.r / 255.0,
                rgba.g / 255.0,
                rgba.b / 255.0,
                rgba.a / 255.0,
              );
            }
            break;
        }
      } else {
        // Fallback to old behavior if no introspection available
        if (rgba.a === undefined || rgba.a === 1.0 || rgba.a === 255) {
          gl.uniform3f(
            location,
            rgba.r / 255.0,
            rgba.g / 255.0,
            rgba.b / 255.0,
          );
        } else {
          gl.uniform4f(
            location,
            rgba.r / 255.0,
            rgba.g / 255.0,
            rgba.b / 255.0,
            rgba.a / 255.0,
          );
        }
      }
    } else if (value && typeof value === "object") {
      // Debug: log unknown object types
      console.error(
        `Unknown object type for uniform ${name ?? uniformInfo?.name}:`,
        {
          value,
          keys: Object.keys(value),
          constructor: value.constructor.name,
          uniformType: uniformInfo?.type,
          uniformName: uniformInfo?.name,
        },
      );
    } else {
      console.error(
        `Failed to set uniform ${uniformInfo?.type} ${name ?? uniformInfo?.name} to ${typeof value} ${value}`,
      );
    }
  } catch (e) {
    console.error(
      `Exception setting uniform parameter ${name ?? uniformInfo?.name} ${value} ${typeof value}: ${e}`,
    );
  }
}
