/* ---------- 公式编辑器侧栏的函数说明（中文说明 + 示例），按函数名对上 shared 的 FUNCTION_DOCS ----------
 * 签名与分组只有 shared 一份（FUNCTION_DOCS）；这里只放给人看的说明。示例里引用的属性名是编辑器里常见的那几种
 * （单价、数量、完成、开始、标签、状态、备注、编号、子任务），单测按一份带这些属性的定义逐个编译，保证示例写得对。 */

export type FormulaFnDoc = { desc: string; example: string }

export const FORMULA_FN_DOCS: Readonly<Record<string, FormulaFnDoc>> = {
  IF: { desc: '条件成立取第二个参数，否则取第三个（省略则为空）。两个结果的类型要一样。', example: 'IF([完成], "✅", "⏳")' },
  IFS: {
    desc: '依次判断各个条件，取第一个成立的条件后面的值；最后落单的一个是都不成立时的缺省值。',
    example: 'IFS([单价] > 100, "贵", [单价] > 10, "中", "便宜")',
  },
  SWITCH: {
    desc: '拿第一个值依次和各个情形比，相等就取对应的结果；最后落单的一个是缺省值。',
    example: 'SWITCH([状态], "已完成", 1, "进行中", 0.5, 0)',
  },
  AND: { desc: '全部条件都成立才为「是」。', example: 'AND([完成], [单价] > 10)' },
  OR: { desc: '有一个条件成立就为「是」。', example: 'OR([完成], [数量] = 0)' },
  NOT: { desc: '取反：是变否，否变是。', example: 'NOT([完成])' },
  ISBLANK: { desc: '值为空（含空文本、空列表）时为「是」。', example: 'ISBLANK([开始])' },

  SUM: { desc: '求和；参数可以是数字，也可以是数字列表（逐项相加）。', example: 'SUM([单价], [数量], 1)' },
  AVERAGE: { desc: '平均值（参数同 SUM）；一个数字都没有时为空。', example: 'AVERAGE([单价], [数量])' },
  MIN: { desc: '最小值（参数同 SUM）。', example: 'MIN([单价], 100)' },
  MAX: { desc: '最大值（参数同 SUM）。', example: 'MAX([单价], 0)' },
  ROUND: { desc: '四舍五入到第几位小数（省略为 0；负数表示到十位、百位）。', example: 'ROUND([单价] / 3, 2)' },
  ROUNDUP: { desc: '朝远离零的方向进到第几位小数。', example: 'ROUNDUP(2.341, 1)' },
  ROUNDDOWN: { desc: '朝零的方向舍到第几位小数。', example: 'ROUNDDOWN(2.349, 2)' },
  CEILING: { desc: '向上取整。', example: 'CEILING([单价])' },
  FLOOR: { desc: '向下取整。', example: 'FLOOR([单价])' },
  ABS: { desc: '绝对值。', example: 'ABS([单价] - 100)' },
  MOD: { desc: '求余数，结果与除数同号；除数为 0 时为空。', example: 'MOD([数量], 3)' },
  POWER: { desc: '乘方：底数的指数次方（同 ^）。', example: 'POWER(2, 10)' },
  SQRT: { desc: '平方根；负数为空。', example: 'SQRT([数量])' },
  INT: { desc: '取不大于它的最大整数。', example: 'INT([单价] / 10)' },

  CONCAT: { desc: '把各个值依次连成文本；数字、日期、列表按显示的文字接上（同 &）。', example: 'CONCAT([编号], " ", [名称])' },
  LEN: { desc: '文本有几个字（emoji 算一个）。', example: 'LEN([名称])' },
  LEFT: { desc: '取左边几个字（省略取 1 个）。', example: 'LEFT([名称], 2)' },
  RIGHT: { desc: '取右边几个字（省略取 1 个）。', example: 'RIGHT([备注], 3)' },
  MID: { desc: '从第几个字起（从 1 数）取几个字。', example: 'MID([名称], 2, 3)' },
  UPPER: { desc: '英文字母转大写。', example: 'UPPER([备注])' },
  LOWER: { desc: '英文字母转小写。', example: 'LOWER([备注])' },
  TRIM: { desc: '去掉首尾的空格，中间连着的空格并成一个。', example: 'TRIM([备注])' },
  SUBSTITUTE: { desc: '把文本里所有的旧文本换成新文本。', example: 'SUBSTITUTE([备注], "旧", "新")' },
  CONTAINS: { desc: '文本里有没有这一段（区分大小写）。', example: 'CONTAINS([名称], "紧急")' },
  TEXT: { desc: '把任何值写成显示的文字（日期写成 YYYY-MM-DD，列表用逗号连起来）。', example: 'TEXT([开始])' },
  VALUE: { desc: '把文本读成数字（认千分位逗号）；认不出为空。', example: 'VALUE("1,200")' },

  TODAY: { desc: '今天，按看的人所在的时区；过了零点要等下次加载才换成新的一天。', example: 'TODAY()' },
  NOW: { desc: '此刻的日期与时间，按看的人所在的时区。', example: 'NOW()' },
  DATE: { desc: '由年、月、日组成日期；月、日超出范围会顺延（13 月是下一年 1 月）。', example: 'DATE(2026, 12, 31)' },
  YEAR: { desc: '日期的年份。', example: 'YEAR([开始])' },
  MONTH: { desc: '日期的月份（1–12）。', example: 'MONTH([开始])' },
  DAY: { desc: '日期是几号（1–31）。', example: 'DAY([开始])' },
  WEEKDAY: { desc: '星期几：周一是 1，周日是 7。', example: 'WEEKDAY(TODAY())' },
  DATEDIF: {
    desc: '两个日期相差多少："D" 天、"M" 整月、"Y" 整年；结束早于开始时为负数。',
    example: 'DATEDIF([开始], TODAY(), "D")',
  },
  DATEADD: { desc: '日期加上若干天 / 周 / 月 / 年（"D" "W" "M" "Y"，数量可以是负数）。', example: 'DATEADD([开始], 7, "D")' },
  START: { desc: '日期区间的开始那天（单日就是它自己）。', example: 'START([开始])' },
  END: { desc: '日期区间的结束那天（单日就是它自己）。', example: 'END([开始])' },

  COUNT: { desc: '列表里有几项（关联了几行、选了几个标签）。', example: 'COUNT([子任务])' },
  JOIN: { desc: '把列表的各项用分隔符连成文本（省略分隔符用「, 」）。', example: 'JOIN([标签], " / ")' },
  FIRST: { desc: '列表的第一项（文字）。', example: 'FIRST([子任务])' },
  LAST: { desc: '列表的最后一项（文字）。', example: 'LAST([标签])' },
  INCLUDES: { desc: '列表里有没有一项的文字等于这个值。', example: 'INCLUDES([标签], "重要")' },
}
