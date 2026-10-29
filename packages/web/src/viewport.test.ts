import { expect, test } from 'vitest'
import { keyboardInset } from './viewport'

/* 不变量：键盘高度 = 布局视口底 − 可视视口底；Chrome 安卓（布局视口自己缩）和没有键盘时恒为 0，不会和 dvh 叠加；永不为负 */
test('iOS：键盘盖住底部，可视视口变矮', () => {
  expect(keyboardInset(800, { height: 500, offsetTop: 0 })).toBe(300)
  expect(keyboardInset(800, { height: 480, offsetTop: 20 })).toBe(300) // 页面被上推了 20px，盖住的还是 300
})

test('Chrome 安卓 resizes-content / 没有键盘：0；浮点与异常值不出负数', () => {
  expect(keyboardInset(500, { height: 500, offsetTop: 0 })).toBe(0)
  expect(keyboardInset(800, { height: 800, offsetTop: 0 })).toBe(0)
  expect(keyboardInset(500, { height: 500.4, offsetTop: 0 })).toBe(0)
  expect(keyboardInset(500, { height: 600, offsetTop: 0 })).toBe(0)
})
