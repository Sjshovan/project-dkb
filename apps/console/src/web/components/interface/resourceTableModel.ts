import { tableFeatures, type ColumnDef } from '@tanstack/vue-table';
import type { ResourceRow } from '../../types.js';

export const resourceTableFeatures = tableFeatures({});
export type ResourceTableFeatures = typeof resourceTableFeatures;
export type ResourceColumn = ColumnDef<ResourceTableFeatures, ResourceRow, unknown>;
