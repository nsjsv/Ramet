/* ---------- 页面封面：预设图库与文案 ----------
 * 预设图随前端静态资源发布（public/covers/，来源与许可见同目录 NOTICE.txt），不进图床：
 * 静态文件走 CDN 缓存，全站共用。<name>.webp 是封面本体（1920 宽），<name>.thumb.webp 是图库格子用的小图。
 * 服务端只校验预设名的形状，不知道这份清单：这里删掉的名字，存量页面会显示成「没有图」的封面底色，不会报错。 */

export type CoverPreset = { name: string; title: string }

export const COVER_PRESETS: CoverPreset[] = [
  { name: 'mountain-reflection', title: '山影倒映' },
  { name: 'lake-silvaplana', title: '席尔瓦普拉纳湖' },
  { name: 'dolomites', title: '多洛米蒂' },
  { name: 'seiser-alm', title: '阿尔卑斯草甸' },
  { name: 'diablo-lake', title: '暗黑湖' },
  { name: 'autumn-lake', title: '秋日湖畔' },
  { name: 'waterfall-valley', title: '瀑布山谷' },
  { name: 'jokulsarlon', title: '冰河湖' },
  { name: 'coastline', title: '海岸线' },
  { name: 'sea-sunset', title: '海上日落' },
  { name: 'lake-dusk', title: '湖畔黄昏' },
  { name: 'misty-countryside', title: '雾中田野' },
]

export const presetSrc = (name: string): string => `/covers/${name}.webp`
export const presetThumb = (name: string): string => `/covers/${name}.thumb.webp`

export function randomPreset(): CoverPreset {
  return COVER_PRESETS[Math.floor(Math.random() * COVER_PRESETS.length)] ?? COVER_PRESETS[0]!
}

export const COVER_COPY = {
  add: '封面',
  addTitle: '添加封面',
  change: '更换封面',
  reposition: '调整位置',
  remove: '移除',
  savePosition: '保存位置',
  cancel: '取消',
  dragHint: '拖动图片调整位置',
  tabGallery: '图库',
  tabUpload: '上传',
  tabLink: '链接',
  uploadPick: '选择图片',
  uploadHint: '建议横图，宽度 1500 像素以上；最大 10MB',
  uploading: '上传中…',
  linkPlaceholder: '粘贴图片链接 https://…',
  linkSubmit: '使用',
  linkInvalid: '需要一个 http(s) 图片链接',
  saveFailed: '封面保存失败',
}
