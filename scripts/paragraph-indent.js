/**
 * 段首缩进 —— 编译期完成，不产生任何额外请求、不引入新依赖
 *
 * 原理：接管 markdown-it 的 paragraph_open 渲染规则，在生成 HTML 时
 *      直接把 style="text-indent:2em" 写进 <p> 标签（编译期求值）。
 *
 * 用法：
 *   1. 默认：正文顶层段落自动缩进两字符
 *      （列表项内、引用块内、纯图片段落不缩进）
 *   2. front-matter 写 indent: false  → 整篇不缩进（编译期剔除，零字节）
 *   3. {% noindent %} ... {% endnoindent %} → 局部段落不缩进
 */

const INDENT_STYLE = ' style="text-indent:2em"'

// 只含图片（或图片链接）的段落不缩进
const isPureImage = inline => {
  if (!inline || inline.type !== 'inline' || !inline.children) return false

  const kids = inline.children.filter(c => !(c.type === 'text' && !c.content.trim()))
  if (!kids.some(c => c.type === 'image')) return false

  return kids.every(c => c.type === 'image' || c.type === 'link_open' || c.type === 'link_close')
}

// 1. 渲染期：给需要缩进的段落写死行内样式
hexo.extend.filter.register('markdown-it:renderer', md => {
  md.renderer.rules.paragraph_open = (tokens, idx) => {
    // hidden = true 表示紧凑列表项，不该输出 <p> 标签
    if (tokens[idx].hidden) return ''

    // level > 0 说明这段在引用块(1)或列表项(2)内，不缩进
    if (tokens[idx].level !== 0) return '<p>'

    return isPureImage(tokens[idx + 1]) ? '<p>' : `<p${INDENT_STYLE}>`
  }
})

// 2. front-matter: indent: false → 整篇不缩进
hexo.extend.filter.register('after_post_render', data => {
  if (data.indent === false) {
    data.content = data.content.split(INDENT_STYLE).join('')
    if (data.excerpt) data.excerpt = data.excerpt.split(INDENT_STYLE).join('')
  }
  return data
})

// 3. {% noindent %} ... {% endnoindent %} → 局部不缩进
hexo.extend.tag.register('noindent', (args, content) => {
  return hexo.render
    .renderSync({ text: content, engine: 'markdown' })
    .trim()
    .split(INDENT_STYLE)
    .join('')
}, { ends: true })
