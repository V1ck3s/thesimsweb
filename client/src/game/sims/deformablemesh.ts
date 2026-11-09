/**
 * DeformableMesh: a skinned mesh (".bmf" binary, ".skn" text).
 *
 * Layout (DeformableMesh::ReadFromFile, CTGFile):
 *   name, textureName,
 *   boneCount, boneName[boneCount],
 *   faceCount, face[faceCount]            3 ints (vertex indices)
 *   bindingCount, BoneBinding[]            5 ints: boneIndex, firstVertex, vertexCount,
 *                                          firstBlendVertex, blendVertexCount
 *   uvCount, uv[uvCount]                   2 floats (= number of real vertices)
 *   blendCount, BlendData[blendCount]      2 ints: weight (0x8000 = 1.0), otherVertex
 *   vertexCount, vertex[vertexCount]       6 floats: position, normal
 *                                          (uvCount real vertices, then the blend vertices)
 * The text form has the same order; its blend lines are "otherVertex weight".
 *
 * Deformation (DeformableMesh::TransformVertices then Blend): each binding moves
 * its real and blend vertices by its bone's world transform (v * M + pos,
 * normals by M only); then each blend vertex is mixed into its "other"
 * vertex: dest = ((0x8000 - w) * dest + w * blend) / 0x8000, normal renormalized.
 */

import { CTGFile, TextStream } from "./ctgfile.js";
import type { Skeleton, Bone } from "./skeleton.js";

export interface BoneBinding {
  boneIndex: number;
  firstVertex: number;
  vertexCount: number;
  firstBlendVertex: number;
  blendVertexCount: number;
}

/** Floats per output vertex: position, normal, uv (the D3DVERTEX layout). */
export const VERTEX_FLOATS = 8;

export class DeformableMesh {
  name = "";
  textureName = "";
  boneNames: string[] = [];
  faces = new Uint16Array(0);
  bindings: BoneBinding[] = [];
  uvs = new Float32Array(0);
  /** Pairs (weight, otherVertex). */
  blends = new Int32Array(0);
  /** Position + normal per vertex (real then blend). */
  vertices = new Float32Array(0);

  get realVertexCount(): number {
    return this.uvs.length / 2;
  }

  static read(bytes: Uint8Array): DeformableMesh {
    const f = new CTGFile(bytes);
    const m = new DeformableMesh();
    m.name = f.readString();
    m.textureName = f.readString();
    let n = f.readInteger();
    for (let i = 0; i < n; i++) m.boneNames.push(f.readString());
    n = f.readInteger();
    m.faces = new Uint16Array(n * 3);
    for (let i = 0; i < n * 3; i++) m.faces[i] = f.readInteger();
    n = f.readInteger();
    for (let i = 0; i < n; i++) {
      m.bindings.push({
        boneIndex: f.readInteger(),
        firstVertex: f.readInteger(),
        vertexCount: f.readInteger(),
        firstBlendVertex: f.readInteger(),
        blendVertexCount: f.readInteger(),
      });
    }
    n = f.readInteger();
    m.uvs = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++) m.uvs[i] = f.readFloat();
    n = f.readInteger();
    m.blends = new Int32Array(n * 2);
    for (let i = 0; i < n * 2; i++) m.blends[i] = f.readInteger();
    n = f.readInteger();
    m.vertices = new Float32Array(n * 6);
    for (let i = 0; i < n * 6; i++) m.vertices[i] = f.readFloat();
    return m;
  }

  /** __rs(istream&, DeformableMesh&): the ".skn" text form. */
  static scan(bytes: Uint8Array): DeformableMesh {
    const s = TextStream.fromBytes(bytes);
    const m = new DeformableMesh();
    m.name = s.line();
    m.textureName = s.line();
    let n = s.int();
    for (let i = 0; i < n; i++) m.boneNames.push(s.line());
    n = s.int();
    m.faces = new Uint16Array(n * 3);
    for (let i = 0; i < n * 3; i++) m.faces[i] = s.int();
    n = s.int();
    for (let i = 0; i < n; i++) {
      m.bindings.push({
        boneIndex: s.int(),
        firstVertex: s.int(),
        vertexCount: s.int(),
        firstBlendVertex: s.int(),
        blendVertexCount: s.int(),
      });
    }
    n = s.int();
    m.uvs = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++) m.uvs[i] = s.float();
    n = s.int();
    m.blends = new Int32Array(n * 2);
    for (let i = 0; i < n; i++) {
      m.blends[i * 2 + 1] = s.int();
      m.blends[i * 2] = s.int();
    }
    n = s.int();
    m.vertices = new Float32Array(n * 6);
    for (let i = 0; i < n * 6; i++) m.vertices[i] = s.float();
    return m;
  }

  /**
   * DeformableMesh::Bind: resolve the bones in a skeleton and pick the
   * texture. `textureSpec` is a body-string texture ("KEY=name"): when KEY
   * occurs in the skin's mesh name the texture is `name`, otherwise the mesh's
   * own texture is used.
   */
  bind(skeleton: Skeleton, textureSpec: string | null, skinName: string = this.name): SkeletonBinding | null {
    const bones: Bone[] = [];
    for (const n of this.boneNames) {
      const b = skeleton.findBone(n);
      if (!b) return null;
      bones.push(b);
    }
    let texture = this.textureName;
    const eq = textureSpec ? textureSpec.indexOf("=") : -1;
    if (textureSpec && eq > 0 && skinName.includes(textureSpec.slice(0, eq))) texture = textureSpec.slice(eq + 1);
    return new SkeletonBinding(this, bones, texture);
  }
}

/** SkeletonBinding: one mesh bound to one skeleton, with its deformed vertex buffer. */
export class SkeletonBinding {
  /** Real vertices then blend scratch vertices, VERTEX_FLOATS each. */
  readonly out: Float32Array;

  constructor(
    readonly mesh: DeformableMesh,
    readonly bones: Bone[],
    readonly texture: string,
  ) {
    const total = mesh.vertices.length / 6;
    this.out = new Float32Array(total * VERTEX_FLOATS);
    const n = mesh.realVertexCount;
    for (let i = 0; i < n; i++) {
      this.out[i * VERTEX_FLOATS + 6] = mesh.uvs[i * 2]!;
      this.out[i * VERTEX_FLOATS + 7] = mesh.uvs[i * 2 + 1]!;
    }
  }

  /** DeformableMesh::TransformVertices + Blend. */
  deform(): void {
    const m = this.mesh;
    const src = m.vertices;
    const out = this.out;
    const real = m.realVertexCount;
    for (let bi = 0; bi < m.bindings.length; bi++) {
      const b = m.bindings[bi]!;
      const bone = this.bones[b.boneIndex];
      if (!bone) continue;
      transform(src, out, b.firstVertex, b.firstVertex, b.vertexCount, bone);
      transform(src, out, real + b.firstBlendVertex, real + b.firstBlendVertex, b.blendVertexCount, bone);
    }
    const bl = m.blends;
    for (let k = 0; k < bl.length / 2; k++) {
      const w = bl[k * 2]!;
      if (w <= 0) continue;
      const d = bl[k * 2 + 1]! * VERTEX_FLOATS;
      const s = (real + k) * VERTEX_FLOATS;
      if (w < 0x8000) {
        const a = 32768 - w;
        for (let c = 0; c < 6; c++) out[d + c] = (1 / 32768) * (a * out[d + c]! + w * out[s + c]!);
        const nx = out[d + 3]!;
        const ny = out[d + 4]!;
        const nz = out[d + 5]!;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        out[d + 3] = nx / l;
        out[d + 4] = ny / l;
        out[d + 5] = nz / l;
      } else {
        for (let c = 0; c < 6; c++) out[d + c] = out[s + c]!;
      }
    }
  }
}

/** RMPASM_xformxlate: out = v * M + t (positions), out = n * M (normals). */
function transform(src: Float32Array, out: Float32Array, from: number, to: number, count: number, bone: Bone): void {
  const M = bone.matrix;
  const [tx, ty, tz] = bone.worldPos;
  for (let i = 0; i < count; i++) {
    const s = (from + i) * 6;
    const o = (to + i) * VERTEX_FLOATS;
    const x = src[s]!;
    const y = src[s + 1]!;
    const z = src[s + 2]!;
    out[o] = x * M[0]! + y * M[3]! + z * M[6]! + tx;
    out[o + 1] = x * M[1]! + y * M[4]! + z * M[7]! + ty;
    out[o + 2] = x * M[2]! + y * M[5]! + z * M[8]! + tz;
    const nx = src[s + 3]!;
    const ny = src[s + 4]!;
    const nz = src[s + 5]!;
    out[o + 3] = nx * M[0]! + ny * M[3]! + nz * M[6]!;
    out[o + 4] = nx * M[1]! + ny * M[4]! + nz * M[7]!;
    out[o + 5] = nx * M[2]! + ny * M[5]! + nz * M[8]!;
  }
}
