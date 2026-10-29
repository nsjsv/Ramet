// 行级 diff 在 shared 里（服务端收尾时也要数增减行，见 run-tally.ts），这里只转出
export { DIFF_CONTEXT, foldDiff, lineDiff, type DiffLine } from '@ramet/shared/run-model'
