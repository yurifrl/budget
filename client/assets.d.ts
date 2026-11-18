/**
 * Metro resolves an imported image to an asset id; expo-image and React
 * Native's Image both accept it as `source`.
 */
declare module '*.png' {
  const asset: number;
  export default asset;
}
