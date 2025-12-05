/**
 * Utils - 工具函数统一导出
 */

export { useDebouncedCallback, useDebouncedValue } from './useDebounce'

export {
  injectMarkers,
  stripMarkers,
  parsePositionId,
  type InjectMarkersOptions,
  type PositionInfo,
} from './typstMarkerInjector'

export {
  CoordinateTransformer,
  createTransformer,
  createCanvasTransformer,
  createDomTransformer,
  type WebPosition,
  type WebRect,
  type CoordinateTransformerOptions,
} from './CoordinateTransformer'
