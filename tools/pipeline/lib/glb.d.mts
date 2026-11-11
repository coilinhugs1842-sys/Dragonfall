import type { Document, NodeIO } from '@gltf-transform/core';

export type AssetKind = 'dragon' | 'rock' | 'prop';
export interface LodStats {
  index: number;
  nodes: string[];
  triangles: number;
  vertices: number;
  primitives: number;
}
export interface GlbAnalysis {
  fileBytes: number;
  nodeNames: string[];
  lods: LodStats[];
  total: { triangles: number; vertices: number; primitives: number };
  bones: string[];
  skins: number;
  materials: string[];
  textures: {
    name: string;
    mimeType: string;
    width: number;
    height: number;
    bytes: number;
    slots: string[];
  }[];
  clips: { name: string; duration: number; channels: number }[];
  colorPrimitives: number;
  primitiveCount: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
}
export interface Finding {
  level: 'error' | 'warn';
  message: string;
}
export function getIO(): Promise<NodeIO>;
export function lodIndexOf(name: string): number;
export function analyzeDocument(document: Document, fileBytes?: number): GlbAnalysis;
export function analyzeFile(path: string): Promise<GlbAnalysis>;
export function inferKind(path: string, analysis?: GlbAnalysis): AssetKind | null;
export function checkGlbBudgets(analysis: GlbAnalysis, kind: AssetKind | null): Finding[];
