// Vite 资产导入（pdfjs worker ?url 等）
declare module '*?url' {
  const url: string
  export default url
}
