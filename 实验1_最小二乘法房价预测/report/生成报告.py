# -*- coding: utf-8 -*-
"""
生成《人工智能数学基础 实验一：基于 NumPy 的最小二乘法 —— 房价预测》实验报告。

输入（只读）：
    ../report/实验报告.md      —— 报告正文（Markdown，含 $$...$$ LaTeX 公式、Markdown 表格、图片占位标记）
    ../results/*.png           —— 三张插图

输出：
    ./人工智能数学基础_实验一_实验报告.docx   （原生 OMML 公式 + 真表格 + 插图）
    ./人工智能数学基础_实验一_实验报告.pdf    （由捆绑 LibreOffice Kit 转换）

用法：
    <bundled-python> 生成报告.py            # 生成 docx + 自检 + 转 PDF
    <bundled-python> 生成报告.py --no-pdf   # 只生成 docx + 自检

实现要点：
  * LaTeX -> MathML (latex2mathml) -> OMML (<m:oMath>)，公式在 Word 中可点击编辑；
  * Markdown 表格 -> 真正的 Word 表格（表头加粗、细边框、数值列右对齐）；
  * 【插入图N】占位标记 -> 按 results/ 下对应图片插入，宽度 14.5cm，图注在图片下方。
"""

import json
import os
import re
import subprocess
import sys
import unicodedata
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape as xesc

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_LINE_SPACING
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from docx.shared import Emu

# --------------------------------------------------------------------------------------
# 路径与常量
# --------------------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent                 # .../实验1_最小二乘法房价预测/report
PROJ = HERE.parent                                     # .../实验1_最小二乘法房价预测
MD_PATH = HERE / "实验报告.md"
RESULTS = PROJ / "results"
OUT_DOCX = HERE / "人工智能数学基础_实验一_实验报告.docx"
OUT_PDF = HERE / "人工智能数学基础_实验一_实验报告.pdf"

FIGURES = {
    1: RESULTS / "图1_散点与最小二乘拟合直线.png",
    2: RESULTS / "图2_各特征与房价的关系.png",
    3: RESULTS / "图3_模型对比.png",
}

FONT_CN = "等线"          # 正文中文
FONT_CN_HEAD = "微软雅黑"  # 标题中文
FONT_EN = "Times New Roman"
FONT_MONO = "Consolas"

BODY_SIZE = Pt(12)        # 小四
CODE_SIZE = Pt(9)         # 小五
TABLE_SIZE = Pt(10)
CAPTION_SIZE = Pt(10.5)   # 五号
CONTENT_WIDTH_CM = 16.0   # A4 + 左右 2.5cm 页边距
IMAGE_WIDTH_CM = 14.5     # <= 15cm

M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MML_NS = "http://www.w3.org/1998/Math/MathML"

# LibreOffice Kit（由 office-docx skill 提供的确切路径，不要另找系统 LibreOffice）
LO_NODE = r"D:\dsh\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
LO_CLI = r"D:\dsh\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit\lib\cli.js"


# --------------------------------------------------------------------------------------
# 一、MathML -> OMML 转换器
# --------------------------------------------------------------------------------------
NARY_CHARS = {"\u2211", "\u220f", "\u222b", "\u222e", "\u222c", "\u222d", "\u22c3", "\u22c2", "\u2a01", "\u2a02"}
LIM_FUNCS = {"min", "max", "lim", "sup", "inf", "det", "gcd", "log", "ln", "exp",
             "sin", "cos", "tan", "arg", "dim", "ker", "deg", "Pr"}
ARROWS = {"\u2192", "\u2190", "\u2194", "\u21d2", "\u21d0", "\u21d4", "\u21a6",
          "\u27f6", "\u27f5", "\u27f7", "\u21cc"}
REL_OPS = {"=", "\u2248", "\u2260", "<", ">", "\u2264", "\u2265", "\u2261",
           "\u2243", "\u2245", "\u223c", "\u221d"}
ACCENT_MAP = {"^": "\u0302", "~": "\u0303", "\u02c6": "\u0302", "\u00af": "\u0304",
              ".": "\u0307", "\u2192": "\u20d7", "\u2015": "\u0305", "-": "\u0305"}

GREEK = {
    "ALPHA": "\u03b1", "BETA": "\u03b2", "GAMMA": "\u03b3", "DELTA": "\u03b4", "EPSILON": "\u03b5",
    "ZETA": "\u03b6", "ETA": "\u03b7", "THETA": "\u03b8", "IOTA": "\u03b9", "KAPPA": "\u03ba",
    "LAMDA": "\u03bb", "LAMBDA": "\u03bb", "MU": "\u03bc", "NU": "\u03bd", "XI": "\u03be",
    "OMICRON": "\u03bf", "PI": "\u03c0", "RHO": "\u03c1", "SIGMA": "\u03c3", "TAU": "\u03c4",
    "UPSILON": "\u03c5", "PHI": "\u03c6", "CHI": "\u03c7", "PSI": "\u03c8", "OMEGA": "\u03c9",
    "NABLA": "\u2207", "PARTIAL DIFFERENTIAL": "\u2202",
}
DIGITS = {"ZERO": "0", "ONE": "1", "TWO": "2", "THREE": "3", "FOUR": "4",
          "FIVE": "5", "SIX": "6", "SEVEN": "7", "EIGHT": "8", "NINE": "9"}

SCR_MAP = {
    "BOLD": (None, "b"), "ITALIC": (None, "i"), "BOLD ITALIC": (None, "bi"),
    "SANS-SERIF": ("sans-serif", "p"), "SANS-SERIF BOLD": ("sans-serif", "b"),
    "SANS-SERIF ITALIC": ("sans-serif", "i"), "SANS-SERIF BOLD ITALIC": ("sans-serif", "bi"),
    "MONOSPACE": ("monospace", "p"), "DOUBLE-STRUCK": ("double-struck", "p"),
    "SCRIPT": ("script", "p"), "BOLD SCRIPT": ("script", "b"),
    "FRAKTUR": ("fraktur", "p"), "BOLD FRAKTUR": ("fraktur", "b"),
}


def _local(el):
    t = el.tag
    if isinstance(t, str) and t.startswith("{"):
        return t.split("}", 1)[1]
    return t


def _text(el):
    return "".join(el.itertext())


def _base_of_kind(kind):
    kind = kind.replace(" SYMBOL", "").strip()
    if kind in GREEK:
        return GREEK[kind]
    if kind in DIGITS:
        return DIGITS[kind]
    if kind.startswith("GREEK SMALL LETTER "):
        return GREEK.get(kind[len("GREEK SMALL LETTER "):])
    if kind.startswith("GREEK CAPITAL LETTER "):
        g = GREEK.get(kind[len("GREEK CAPITAL LETTER "):])
        return g.upper() if g else None
    if kind.startswith("CAPITAL "):
        return kind[len("CAPITAL "):]
    if kind.startswith("SMALL "):
        return kind[len("SMALL "):]
    if kind.startswith("DIGIT "):
        return DIGITS.get(kind[len("DIGIT "):])
    return None


def _math_variant(ch):
    """把 U+1D400..U+1D7FF / U+2100 区的数学字母数字还原成 (基本字符, 字体变体名)。"""
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return None
    if name.startswith("MATHEMATICAL "):
        rest = name[len("MATHEMATICAL "):]
    elif name.startswith("DOUBLE-STRUCK "):
        rest = name
    elif name.startswith("SCRIPT "):
        rest = name
    elif name.startswith("BLACK-LETTER "):
        rest = "FRAKTUR " + name[len("BLACK-LETTER "):]
    else:
        return None
    variants = sorted(SCR_MAP.keys(), key=len, reverse=True)
    for v in variants:
        if rest.startswith(v + " "):
            b = _base_of_kind(rest[len(v) + 1:])
            if b:
                return (b, v)
    return None


def _run(text, scr=None, sty=None, nor=False):
    """生成一个 OMML 数学 run。"""
    props = []
    if nor:
        props.append("<m:nor/>")
    if scr:
        props.append('<m:scr m:val="%s"/>' % scr)
    if sty:
        props.append('<m:sty m:val="%s"/>' % sty)
    rpr = "<m:rPr>%s</m:rPr>" % "".join(props) if props else ""
    return '<m:r>%s<m:t xml:space="preserve">%s</m:t></m:r>' % (rpr, xesc(text))


def _runs_for_text(text, nor=False):
    """普通数学字符序列 -> OMML，顺带处理数学字母数字变体。"""
    out = []
    for ch in text:
        mv = None
        if ch > "\uffff" or ch in "\u211d\u211a\u2115\u2124\u2102\u2119\u210d\u2110\u211b\u212c\u2130\u2131\u2133":
            mv = _math_variant(ch)
        if mv:
            base, variant = mv
            scr, sty = SCR_MAP.get(variant, (None, None))
            out.append(_run(base, scr=scr, sty=sty))
        else:
            out.append(_run(ch, nor=nor))
    return "".join(out)


def _nary(chr_, sub, sup, e):
    return ('<m:nary><m:naryPr><m:chr m:val="%s"/><m:limLoc m:val="undOvr"/></m:naryPr>'
            "<m:sub>%s</m:sub><m:sup>%s</m:sup><m:e>%s</m:e></m:nary>" % (xesc(chr_), sub, sup, e))


def _matrix(el):
    rows = [c for c in el if _local(c) == "mtr"]
    ncols = 1
    cells_per_row = []
    for r in rows:
        cells = [c for c in r if _local(c) == "mtd"]
        cells_per_row.append(cells)
        ncols = max(ncols, len(cells))
    body = []
    for cells in cells_per_row:
        parts = []
        for c in cells:
            parts.append("<m:e>%s</m:e>" % _seq(list(c)))
        while len(parts) < ncols:
            parts.append("<m:e/>")
        body.append("<m:mr>%s</m:mr>" % "".join(parts))
    mpr = ('<m:mPr><m:baseJc m:val="center"/>'
           '<m:mcs><m:mc><m:mcPr><m:count m:val="%d"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs>'
           "</m:mPr>" % ncols)
    return "<m:m>%s%s</m:m>" % (mpr, "".join(body))


def _delim(open_ch, table_el, close_ch):
    return ('<m:d><m:dPr><m:begChr m:val="%s"/><m:endChr m:val="%s"/></m:dPr><m:e>%s</m:e></m:d>'
            % (xesc(open_ch), xesc(close_ch), _matrix(table_el)))


def _spaces(el):
    w = el.get("width") or "0.25em"
    try:
        em = float(re.sub(r"[^0-9.]", "", w) or "0.25")
    except ValueError:
        em = 0.25
    if "em" not in w:
        em = em * 12
    n = max(1, min(8, int(round(em * 2))))
    return _run("\u00a0" * n, nor=True)


def _accent(base_xml, chr_xml):
    return "<m:acc><m:accPr><m:chr m:val=\"%s\"/></m:accPr><m:e>%s</m:e></m:acc>" % (xesc(chr_xml), base_xml)


def _node(el):
    ln = _local(el)
    kids = list(el)

    if ln in ("math", "mrow", "mstyle", "mpadded", "mphantom", "semantics"):
        if ln == "semantics" and kids:
            return _node(kids[0])
        return _seq(kids)
    if ln == "mi":
        return _runs_for_text(_text(el))
    if ln == "mn":
        return _runs_for_text(_text(el), nor=True)
    if ln == "mo":
        t = _text(el)
        if len(t) > 1 and t.isalpha():
            return _run(t, nor=True)
        return _runs_for_text(t)
    if ln == "mtext":
        t = _text(el)
        clean = t.replace("\u00a0", " ")
        if not clean.strip():
            return _run("\u00a0", nor=True)
        return _run(clean, nor=True)
    if ln == "mspace":
        return _spaces(el)
    if ln in ("msup", "msub", "msubsup"):
        base_el = kids[0]
        base = _node(base_el)
        base_txt = _text(base_el).strip()
        # 注意：msup 只有 [底, 上标] 两个子元素；msub 是 [底, 下标]；
        # msubsup 才是 [底, 下标, 上标]。
        if ln == "msup":
            sup = _node(kids[1]) if len(kids) > 1 else ""
            return "<m:sSup><m:e>%s</m:e><m:sup>%s</m:sup></m:sSup>" % (base, sup)
        sub = _node(kids[1]) if len(kids) > 1 else ""
        if ln == "msub":
            if base_txt in LIM_FUNCS:
                return "<m:limLow><m:e>%s</m:e><m:lim>%s</m:lim></m:limLow>" % (_run(base_txt, nor=True), sub)
            return "<m:sSub><m:e>%s</m:e><m:sub>%s</m:sub></m:sSub>" % (base, sub)
        sup = _node(kids[2]) if len(kids) > 2 else ""
        if base_txt in LIM_FUNCS:
            low = "<m:limLow><m:e>%s</m:e><m:lim>%s</m:lim></m:limLow>" % (_run(base_txt, nor=True), sub)
            return "<m:limUpp><m:e>%s</m:e><m:lim>%s</m:lim></m:limUpp>" % (low, sup)
        return "<m:sSubSup><m:e>%s</m:e><m:sub>%s</m:sub><m:sup>%s</m:sup></m:sSubSup>" % (base, sub, sup)
    if ln in ("munder", "munderover"):
        base_xml = _node(kids[0])
        low = _node(kids[1]) if len(kids) > 1 else ""
        up = _node(kids[2]) if len(kids) > 2 else ""
        nested = "<m:limLow><m:e>%s</m:e><m:lim>%s</m:lim></m:limLow>" % (base_xml, low)
        if ln == "munder":
            return nested
        return "<m:limUpp><m:e>%s</m:e><m:lim>%s</m:lim></m:limUpp>" % (nested, up)
    if ln == "mover":
        base = kids[0] if kids else None
        over = _node(kids[1]) if len(kids) > 1 else ""
        base_txt = _text(base).strip() if base is not None else ""
        if base_txt in ARROWS:
            return "<m:limUpp><m:e>%s</m:e><m:lim>%s</m:lim></m:limUpp>" % (_runs_for_text(base_txt), over)
        chr_x = "\u0302"
        if len(kids) > 1:
            raw = _text(kids[1]).strip()
            chr_x = ACCENT_MAP.get(raw, raw or "\u0302")
        return _accent(_node(base) if base is not None else "", chr_x)
    if ln == "mfrac":
        num = _node(kids[0])
        den = _node(kids[1]) if len(kids) > 1 else ""
        return "<m:f><m:num>%s</m:num><m:den>%s</m:den></m:f>" % (num, den)
    if ln == "msqrt":
        return '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>%s</m:e></m:rad>' % _seq(kids)
    if ln == "mroot":
        return "<m:rad><m:deg>%s</m:deg><m:e>%s</m:e></m:rad>" % (_node(kids[1]), _node(kids[0]))
    if ln == "mtable":
        return _matrix(el)
    if ln == "menclose":
        notation = el.get("notation", "")
        if "box" in notation:
            return "<m:borderBox><m:borderBoxPr/><m:e>%s</m:e></m:borderBox>" % _seq(kids)
        return _seq(kids)
    return _seq(kids)


def _seq(nodes):
    out = []
    i = 0
    n = len(nodes)
    while i < n:
        el = nodes[i]
        ln = _local(el)
        t = _text(el)
        # [ ...矩阵... ] -> m:d
        if (ln == "mo" and t.strip() in ("[", "(", "{")) and i + 2 < n and _local(nodes[i + 1]) == "mtable":
            close = ""
            if i + 2 < n and _local(nodes[i + 2]) == "mo":
                close = _text(nodes[i + 2]).strip()
                out.append(_delim(t.strip(), nodes[i + 1], close))
                i += 3
                continue
            out.append(_delim(t.strip(), nodes[i + 1], ""))
            i += 2
            continue
        # 大算符带上下限 -> m:nary，被加项吞掉后续内容（遇到关系运算符停）
        if ln in ("msubsup", "munderover") and list(el) and _text(list(el)[0]).strip() in NARY_CHARS:
            kids = list(el)
            sub = _node(kids[1]) if len(kids) > 1 else ""
            sup = _node(kids[2]) if len(kids) > 2 else ""
            k = 1
            while i + k < n:
                nxt = nodes[i + k]
                if _local(nxt) == "mo" and _text(nxt).strip() in REL_OPS:
                    break
                k += 1
            operand = _seq(nodes[i + 1: i + k])
            out.append(_nary(_text(kids[0]).strip(), sub, sup, operand))
            i += k
            continue
        out.append(_node(el))
        i += 1
    return "".join(out)


def strip_boxed(tex):
    """把 \\boxed{...} 的外层去掉（方框改用段落下边框，见 add_math）。"""
    out = tex
    while "\\boxed" in out:
        i = out.index("\\boxed")
        j = out.index("{", i)
        depth = 0
        k = j
        while k < len(out):
            if out[k] == "{":
                depth += 1
            elif out[k] == "}":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        out = out[:i] + out[j + 1:k] + out[k + 1:]
    return out


def latex_to_omml(latex: str):
    """LaTeX -> OMML 字符串（<m:oMath> 根元素）。失败返回 None。"""
    import latex2mathml.converter as l2m
    from lxml import etree

    mml = l2m.convert(latex)
    root = etree.fromstring(mml.encode("utf-8"))
    body = _node(root)
    return '<m:oMath xmlns:m="%s" xmlns:w="%s">%s</m:oMath>' % (M_NS, W_NS, body)


# --------------------------------------------------------------------------------------
# 二、底层 docx 工具
# --------------------------------------------------------------------------------------
PPR_ORDER = ["w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr", "w:widowControl",
             "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd", "w:tabs", "w:suppressAutoHyphens",
             "w:kinsoku", "w:wordWrap", "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN",
             "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind", "w:contextualSpacing",
             "w:mirrorIndents", "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment",
             "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange"]
TCPR_ORDER = ["w:cnfStyle", "w:tcW", "w:gridSpan", "w:hMerge", "w:vMerge", "w:tcBorders", "w:shd",
              "w:noWrap", "w:tcMar", "w:textDirection", "w:tcFitText", "w:vAlign", "w:hideMark"]
TBLPR_ORDER = ["w:tblStyle", "w:tblpPr", "w:tblOverlap", "w:bidiVisual", "w:tblStyleRowBandSize",
               "w:tblStyleColBandSize", "w:tblW", "w:jc", "w:tblCellSpacing", "w:tblInd", "w:tblBorders",
               "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook", "w:tblCaption", "w:tblDescription"]


def insert_ordered(parent, elem, order):
    """按 OOXML schema 规定的子元素顺序插入（同标签先删除）。"""
    tag = elem.tag
    ordered = [qn(o) for o in order]
    for child in list(parent):
        if child.tag == tag:
            parent.remove(child)
    if tag not in ordered:
        parent.append(elem)
        return elem
    wanted = ordered.index(tag)
    pos = len(parent)
    for i, child in enumerate(parent):
        if child.tag in ordered and ordered.index(child.tag) > wanted:
            pos = i
            break
    parent.insert(pos, elem)
    return elem


def set_east_asian(run_or_style, ascii_font, ea_font, size=None, bold=None, italic=None, color=None):
    rpr = run_or_style._element.get_or_add_rPr() if hasattr(run_or_style, "_element") else run_or_style.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        insert_ordered(rpr, rfonts, ["w:rStyle", "w:rFonts", "w:b", "w:i", "w:sz", "w:color"])
    rfonts.set(qn("w:ascii"), ascii_font)
    rfonts.set(qn("w:hAnsi"), ascii_font)
    rfonts.set(qn("w:eastAsia"), ea_font)
    rfonts.set(qn("w:cs"), ascii_font)
    if hasattr(run_or_style, "font"):
        f = run_or_style.font
        if size is not None:
            f.size = size
        if bold is not None:
            f.bold = bold
        if italic is not None:
            f.italic = italic
        if color is not None:
            f.color.rgb = color


def set_para_shading(p, fill="F2F2F2"):
    pPr = p._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    insert_ordered(pPr, shd, PPR_ORDER)


def set_first_line_indent(p, chars=2, pts=24):
    pPr = p._p.get_or_add_pPr()
    ind = pPr.find(qn("w:ind"))
    if ind is None:
        ind = OxmlElement("w:ind")
        insert_ordered(pPr, ind, PPR_ORDER)
    ind.set(qn("w:firstLineChars"), str(int(chars * 100)))
    ind.set(qn("w:firstLine"), str(int(pts * 20)))
    ind.set(qn("w:left"), "0")


def clear_indent(p):
    pPr = p._p.get_or_add_pPr()
    for tag in ("w:ind", "w:shd"):
        for e in pPr.findall(qn(tag)):
            pPr.remove(e)


def set_hanging_indent(p, left_cm=0.74, hanging_cm=0.74):
    pPr = p._p.get_or_add_pPr()
    ind = pPr.find(qn("w:ind"))
    if ind is None:
        ind = OxmlElement("w:ind")
        insert_ordered(pPr, ind, PPR_ORDER)
    ind.set(qn("w:left"), str(int(left_cm * 567)))
    ind.set(qn("w:hanging"), str(int(hanging_cm * 567)))


def no_grid_lines(p):
    """关闭网格对齐，避免 1.5 倍行距与网格冲突。"""
    pPr = p._p.get_or_add_pPr()
    for tag in ("w:snapToGrid",):
        for e in pPr.findall(qn(tag)):
            pPr.remove(e)
    e = OxmlElement("w:snapToGrid")
    e.set(qn("w:val"), "0")
    insert_ordered(pPr, e, PPR_ORDER)


# --------------------------------------------------------------------------------------
# 三、Markdown 解析
# --------------------------------------------------------------------------------------
BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.S)
CODE_RE = re.compile(r"`([^`]+)`")


def is_block_start(line):
    s = line.strip()
    if s == "":
        return True
    if s.startswith("#") or s.startswith("```") or s.startswith("|"):
        return True
    if s.startswith("$$"):
        return True
    if re.fullmatch(r"-{3,}", s):
        return True
    # 列表项各占一块（同一项的续行通常是缩进的，不会命中这里）
    if re.match(r"^[-*]\s+", s) or re.match(r"^\d+[.、]\s+", s):
        return True
    return False


def join_wrapped(parts):
    out = ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if out and re.search(r"[A-Za-z0-9)\]}.,;:!?%]$", out) and re.match(r"^[A-Za-z0-9(\[{]", p):
            out += " " + p
        else:
            out += p
    return out


def parse_markdown(text):
    lines = text.split("\n")
    # 从正文（「## 摘要」）开始，前面的标题/封面信息由封面页负责
    start = 0
    for i, l in enumerate(lines):
        if l.startswith("## "):
            start = i
            break
    lines = lines[start:]
    blocks = []
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        s = raw.strip()
        if s == "":
            i += 1
            continue
        if s.startswith("```"):
            lang = s[3:].strip()
            buf = []
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            blocks.append({"type": "code", "lang": lang, "lines": buf})
            continue
        if s.startswith("$$"):
            if s.endswith("$$") and len(s) > 4:
                blocks.append({"type": "math", "tex": s[2:-2].strip()})
                i += 1
            else:
                buf = [s[2:]]
                i += 1
                while i < n and "$$" not in lines[i]:
                    buf.append(lines[i])
                    i += 1
                if i < n:
                    buf.append(lines[i].split("$$")[0])
                blocks.append({"type": "math", "tex": " ".join(x.strip() for x in buf).strip()})
                i += 1
            continue
        if s.startswith("#"):
            m = re.match(r"^(#+)\s*(.*)$", s)
            blocks.append({"type": "heading", "level": len(m.group(1)), "text": m.group(2).strip()})
            i += 1
            continue
        if s.startswith("|"):
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(lines[i].strip())
                i += 1
            blocks.append({"type": "table", "rows": rows})
            continue
        if re.fullmatch(r"-{3,}", s):
            blocks.append({"type": "hr"})
            i += 1
            continue
        # 段落 / 列表：第一行无条件纳入本块，其后续行遇到块起始标记就结束
        buf = [lines[i]]
        i += 1
        while i < n and not is_block_start(lines[i]):
            buf.append(lines[i])
            i += 1
        if not buf:
            continue
        first = buf[0].strip()
        if first.startswith("- "):
            text_j = join_wrapped([first[2:]] + [b.strip() for b in buf[1:]])
            blocks.append({"type": "bullet", "text": text_j})
        elif re.match(r"^\d+\.\s", first):
            head = re.match(r"^(\d+\.)\s+(.*)$", first)
            text_j = join_wrapped([head.group(2)] + [b.strip() for b in buf[1:]])
            blocks.append({"type": "number", "marker": head.group(1), "text": text_j})
        else:
            blocks.append({"type": "para", "text": join_wrapped(buf)})
    return blocks


# --------------------------------------------------------------------------------------
# 四、docx 渲染
# --------------------------------------------------------------------------------------
class Builder:
    def __init__(self):
        self.doc = Document()
        self.omml_total = 0
        self.omml_failed = []
        self.figures_inserted = []
        self._setup_styles()
        self._setup_page()
        self._build_cover()

    # ---------- 基础设置 ----------
    def _setup_page(self):
        sec = self.doc.sections[0]
        sec.page_width = Cm(21.0)
        sec.page_height = Cm(29.7)
        sec.top_margin = Cm(2.54)
        sec.bottom_margin = Cm(2.54)
        sec.left_margin = Cm(2.5)
        sec.right_margin = Cm(2.5)

    def _setup_styles(self):
        st = self.doc.styles
        normal = st["Normal"]
        set_east_asian(normal, FONT_EN, FONT_CN, size=BODY_SIZE)
        pf = normal.paragraph_format
        pf.line_spacing = 1.5
        pf.space_before = Pt(0)
        pf.space_after = Pt(0)
        pf.first_line_indent = Pt(0)

        conf = [("Heading 1", 16, 14, 10), ("Heading 2", 14, 12, 8), ("Heading 3", 13, 10, 6),
                ("Heading 4", 12, 8, 6)]
        for name, size, before, after in conf:
            h = st[name]
            set_east_asian(h, FONT_CN_HEAD, FONT_CN_HEAD, size=Pt(size), bold=True,
                           italic=False, color=RGBColor(0, 0, 0))
            pf = h.paragraph_format
            pf.space_before = Pt(before)
            pf.space_after = Pt(after)
            pf.line_spacing = 1.5
            pf.first_line_indent = Pt(0)
            pf.keep_with_next = True
            # 去掉默认的蓝色
            rpr = h._element.get_or_add_rPr()
            for c in rpr.findall(qn("w:color")):
                rpr.remove(c)
            col = OxmlElement("w:color")
            col.set(qn("w:val"), "000000")
            rpr.append(col)

    # ---------- 封面 ----------
    def _cover_line(self, text, size, bold=False, space_after=0, align=WD_ALIGN_PARAGRAPH.CENTER):
        p = self.doc.add_paragraph()
        p.alignment = align
        pf = p.paragraph_format
        pf.first_line_indent = Pt(0)
        pf.line_spacing = 1.5
        pf.space_after = Pt(space_after)
        r = p.add_run(text)
        set_east_asian(r, FONT_CN_HEAD, FONT_CN_HEAD, size=Pt(size), bold=bold,
                       color=RGBColor(0, 0, 0))
        return p

    def _build_cover(self):
        for _ in range(4):
            self._cover_line("", 12)
        self._cover_line("人工智能数学基础", 16, bold=False, space_after=6)
        self._cover_line("实验报告", 16, bold=False, space_after=30)
        self._cover_line("人工智能数学基础 实验一：", 20, bold=True, space_after=2)
        self._cover_line("基于 NumPy 的最小二乘法 —— 房价预测", 20, bold=True, space_after=48)
        self._cover_line("课程名称：人工智能数学基础", 14, space_after=10)
        self._cover_line("实验名称：实验一 · 基于 NumPy 的最小二乘法 —— 房价预测", 14, space_after=10)
        self._cover_line("学号 / 姓名：学号_姓名", 14, space_after=10)
        self._cover_line("完成日期：2026 年 10 月", 14, space_after=0)
        # 分页
        p = self.doc.add_paragraph()
        p.paragraph_format.first_line_indent = Pt(0)
        p.add_run().add_break(WD_BREAK.PAGE)

    # ---------- 文本 run ----------
    def _add_runs(self, p, text, size=BODY_SIZE, base_font=(FONT_EN, FONT_CN), mono=False):
        pos = 0
        pattern = re.compile(r"(\*\*.+?\*\*|`[^`]+`|\$[^$]+\$)", re.S)
        for m in pattern.finditer(text):
            if m.start() > pos:
                seg = text[pos:m.start()]
                if seg:
                    r = p.add_run(seg)
                    set_east_asian(r, base_font[0], base_font[1], size=size)
            tok = m.group(0)
            if tok.startswith("**"):
                r = p.add_run(tok[2:-2])
                set_east_asian(r, FONT_CN_HEAD, FONT_CN_HEAD, size=size, bold=True)
            elif tok.startswith("`"):
                r = p.add_run(tok[1:-1])
                set_east_asian(r, FONT_MONO, FONT_CN, size=Pt(size.pt - 1.5))
            else:  # $...$ 行内公式
                omml = latex_to_omml(tok[1:-1])
                if omml is not None:
                    p._p.append(parse_xml(omml))
                    self.omml_total += 1
                else:
                    self.omml_failed.append(tok)
                    r = p.add_run(tok[1:-1])
                    set_east_asian(r, base_font[0], base_font[1], size=size)
            pos = m.end()
        if pos < len(text):
            seg = text[pos:]
            if seg:
                r = p.add_run(seg)
                set_east_asian(r, base_font[0], base_font[1], size=size)

    # ---------- 各类块 ----------
    def add_heading(self, level, text):
        style = "Heading %d" % min(4, max(1, level - 1))
        p = self.doc.add_paragraph(style=style)
        self._add_runs(p, text, size=Pt({1: 16, 2: 14, 3: 13, 4: 12}[min(4, max(1, level - 1))]),
                       base_font=(FONT_CN_HEAD, FONT_CN_HEAD))
        return p

    def add_para(self, text):
        p = self.doc.add_paragraph()
        p.paragraph_format.line_spacing = 1.5
        set_first_line_indent(p, 2, 24)
        no_grid_lines(p)
        self._add_runs(p, text, size=BODY_SIZE)
        return p

    def add_bullet(self, text):
        p = self.doc.add_paragraph()
        p.paragraph_format.line_spacing = 1.5
        clear_indent(p)
        set_hanging_indent(p, left_cm=0.9, hanging_cm=0.9)
        self._add_runs(p, "\u25cf " + text, size=BODY_SIZE)
        return p

    def add_number(self, marker, text):
        p = self.doc.add_paragraph()
        p.paragraph_format.line_spacing = 1.5
        clear_indent(p)
        set_hanging_indent(p, left_cm=0.9, hanging_cm=0.9)
        self._add_runs(p, marker + " " + text, size=BODY_SIZE)
        return p

    def add_code(self, lines):
        if not lines:
            lines = [""]
        for k, line in enumerate(lines):
            p = self.doc.add_paragraph()
            pf = p.paragraph_format
            pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
            pf.space_before = Pt(0)
            pf.space_after = Pt(0)
            pf.first_line_indent = Pt(0)
            pf.left_indent = Pt(6)
            pf.keep_with_next = k < len(lines) - 1
            clear_indent(p)
            set_para_shading(p, "F2F2F2")
            no_grid_lines(p)
            r = p.add_run(line if line else "")
            set_east_asian(r, FONT_MONO, FONT_CN, size=CODE_SIZE)

    def add_math(self, tex):
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pf = p.paragraph_format
        pf.first_line_indent = Pt(0)
        pf.space_before = Pt(6)
        pf.space_after = Pt(6)
        pf.line_spacing = 1.5
        no_grid_lines(p)
        boxed = "\\boxed" in tex
        if boxed:
            tex = strip_boxed(tex)
        omml = latex_to_omml(tex)
        if omml is None:
            self.omml_failed.append(tex)
            r = p.add_run(self._plain_fallback(tex))
            set_east_asian(r, FONT_EN, FONT_CN, size=BODY_SIZE)
            return p
        p._p.append(parse_xml(omml))
        self.omml_total += 1
        if boxed:
            # LibreOffice 对 OMML 的 m:borderBox 只画上下两条线，改用段落边框
            # 画一个完整的方框；公式本体仍是可编辑的原生 OMML。
            self._box_paragraph(p)
        return p

    @staticmethod
    def _box_paragraph(p, sz=6, space=6):
        pPr = p._p.get_or_add_pPr()
        pbdr = OxmlElement("w:pBdr")
        for side in ("top", "left", "bottom", "right"):
            e = OxmlElement("w:" + side)
            e.set(qn("w:val"), "single")
            e.set(qn("w:sz"), str(sz))
            e.set(qn("w:space"), str(space))
            e.set(qn("w:color"), "000000")
            pbdr.append(e)
        insert_ordered(pPr, pbdr, PPR_ORDER)

    @staticmethod
    def _plain_fallback(tex):
        s = tex
        s = re.sub(r"\\text\{([^}]*)\}", r"\1", s)
        s = re.sub(r"\\mathrm\{([^}]*)\}", r"\1", s)
        s = re.sub(r"\\hat\{([^}]*)\}", r"\1\u0302", s)
        s = s.replace("\\theta", "\u03b8").replace("\\sum", "\u2211").replace("\\cdot", "\u00b7")
        s = s.replace("\\frac", "/").replace("\\\\", " ")
        return s

    def add_caption_item(self, text, marker=None):
        """图注下面的解释条目（小一号、左对齐、悬挂缩进，与图注连成一块）。"""
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        pf = p.paragraph_format
        pf.first_line_indent = Pt(0)
        pf.left_indent = Cm(1.1)
        pf.space_before = Pt(0)
        pf.space_after = Pt(2)
        pf.line_spacing = 1.2
        clear_indent(p)
        set_hanging_indent(p, left_cm=1.1, hanging_cm=0.5)
        no_grid_lines(p)
        self._add_runs(p, (marker + " " if marker else "\u25cf ") + text, size=CAPTION_SIZE)
        return p

    def add_caption(self, text):
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pf = p.paragraph_format
        pf.first_line_indent = Pt(0)
        pf.space_before = Pt(3)
        pf.space_after = Pt(10)
        pf.line_spacing = 1.25
        no_grid_lines(p)
        self._add_runs(p, text, size=CAPTION_SIZE)
        return p

    def add_figure(self, idx):
        path = FIGURES[idx]
        p = self.doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        pf = p.paragraph_format
        pf.first_line_indent = Pt(0)
        pf.space_before = Pt(6)
        pf.space_after = Pt(2)
        pf.line_spacing = 1.0
        no_grid_lines(p)
        run = p.add_run()
        run.add_picture(str(path), width=Cm(IMAGE_WIDTH_CM))
        self.figures_inserted.append((idx, path.name))

    # ---------- 表格 ----------
    NUM_RE = re.compile(r"^[\u2212\-+]?(\d+(\.\d+)?|\.\d+)([eE][\u2212\-+]?\d+)?%?$")

    @staticmethod
    def _split_row(row):
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        return cells

    @classmethod
    def _is_numeric(cls, s):
        t = s.replace("**", "").replace(" ", "").strip()
        return bool(cls.NUM_RE.match(t))

    @staticmethod
    def _disp_width(s):
        t = s.replace("**", "")
        return sum(2 if ord(c) > 0x2000 else 1 for c in t)

    # 表格列宽估算参数：ASCII 字符按 0.62 em 计（LibreOffice 可能把 Times New Roman
    # 替换成更宽的字体），单元格左右边距按 0.15cm 计（比 tblCellMar 设的 0.106cm 保守）
    ASCII_EM = 0.62
    CELL_PAD_CM = 0.15

    @classmethod
    def _text_pt(cls, s, size_pt):
        pt = 0.0
        for ch in s:
            pt += size_pt * (1.0 if ord(ch) > 0x2000 else cls.ASCII_EM)
        return pt

    @classmethod
    def _desired_cm(cls, cells, size_pt, bold):
        """整格内容不换行所需宽度（cm）。"""
        pt = max(cls._text_pt(c.replace("**", "").replace("\u00a0", " "), size_pt) for c in cells)
        return pt * (1.10 if bold else 1.04) / 28.3465 + 2 * cls.CELL_PAD_CM

    @classmethod
    def _min_cm(cls, cells, size_pt, bold):
        """最小可接受宽度：按最长"不可断片段"估算（汉字单字可断，数字/英文单词不可断）。"""
        best = 0.0
        cjk = r"[\u3000-\u9fff\uff00-\uffef\u3001\u3002\uff0c-\uff1b\u2018-\u201d]"
        for c in cells:
            s = c.replace("**", "").replace("\u00a0", " ")
            for tok in re.split(r"[\s/]+", s):
                if not tok:
                    continue
                for piece in re.findall(cjk + r"+|[^" + cjk[1:-1] + r"]+", tok):
                    if re.fullmatch(cjk + "+", piece):
                        w = size_pt
                    else:
                        w = cls._text_pt(piece, size_pt)
                    best = max(best, w)
        return best * (1.10 if bold else 1.04) / 28.3465 + 2 * cls.CELL_PAD_CM

    def add_table(self, rows):
        header = self._split_row(rows[0])
        data = [self._split_row(r) for r in rows[1:] if not re.fullmatch(r"\|[\s\-:|]+\|", r.strip())]
        ncols = max(len(header), max((len(r) for r in data), default=0))
        header += [""] * (ncols - len(header))
        for r in data:
            r += [""] * (ncols - len(r))

        table = self.doc.add_table(rows=1 + len(data), cols=ncols)
        table.style = self.doc.styles["Table Grid"]
        table.alignment = WD_TABLE_ALIGNMENT.CENTER
        table.autofit = False

        size = TABLE_SIZE if ncols <= 6 else Pt(9)
        numeric_col = [False] * ncols
        for c in range(ncols):
            vals = [r[c] for r in data if r[c].strip() != ""]
            numeric_col[c] = bool(vals) and all(self._is_numeric(v) for v in vals)

        # 表头
        for c, cell_text in enumerate(header):
            cell = table.cell(0, c)
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pf = p.paragraph_format
            pf.first_line_indent = Pt(0)
            pf.line_spacing = 1.15
            pf.space_before = Pt(1)
            pf.space_after = Pt(1)
            self._add_runs(p, cell_text, size=size, base_font=(FONT_CN_HEAD, FONT_CN_HEAD))
            for r in p.runs:
                r.font.bold = True
            self._cell_shade(cell, "D9D9D9")
        # 数据
        for ri, row in enumerate(data, start=1):
            for c, cell_text in enumerate(row):
                cell = table.cell(ri, c)
                p = cell.paragraphs[0]
                p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if numeric_col[c] else WD_ALIGN_PARAGRAPH.LEFT
                pf = p.paragraph_format
                pf.first_line_indent = Pt(0)
                pf.line_spacing = 1.15
                pf.space_before = Pt(1)
                pf.space_after = Pt(1)
                self._add_runs(p, cell_text, size=size)

        # 列宽：先算"最小不折断宽度"，再把剩余空间按需分配给需要更宽的列
        col_cells = [[header[c]] + [r[c] for r in data] for c in range(ncols)]
        col_bold = [any("**" in x for x in cells) for cells in col_cells]
        mins = [self._min_cm(cells, size.pt, b) for cells, b in zip(col_cells, col_bold)]
        desired = [max(m, self._desired_cm(cells, size.pt, b))
                   for cells, b, m in zip(col_cells, col_bold, mins)]
        sum_min, sum_des = sum(mins), sum(desired)
        if sum_des <= CONTENT_WIDTH_CM:
            extra = CONTENT_WIDTH_CM - sum_des
            widths = [d + extra * d / sum_des for d in desired]
        elif sum_min < CONTENT_WIDTH_CM:
            remaining = CONTENT_WIDTH_CM - sum_min
            need = [d - m for d, m in zip(desired, mins)]
            total_need = sum(need) or 1.0
            widths = [m + remaining * n / total_need for m, n in zip(mins, need)]
        else:
            widths = [CONTENT_WIDTH_CM * m / sum_min for m in mins]
        scale = CONTENT_WIDTH_CM / sum(widths)
        widths = [w * scale for w in widths]
        self._apply_widths(table, widths)

        # 表头跨页重复
        tr = table.rows[0]._tr
        trPr = tr.get_or_add_trPr()
        th = OxmlElement("w:tblHeader")
        trPr.append(th)

        # 表后空一点
        p = self.doc.add_paragraph()
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.0
        p.paragraph_format.first_line_indent = Pt(0)
        for r in p.runs:
            r.font.size = Pt(6)
        return table

    @staticmethod
    def _cell_shade(cell, fill):
        tcPr = cell._tc.get_or_add_tcPr()
        shd = OxmlElement("w:shd")
        shd.set(qn("w:val"), "clear")
        shd.set(qn("w:color"), "auto")
        shd.set(qn("w:fill"), fill)
        insert_ordered(tcPr, shd, TCPR_ORDER)

    @staticmethod
    def _apply_widths(table, widths_cm):
        tbl = table._tbl
        tblPr = tbl.tblPr
        tw = OxmlElement("w:tblW")
        tw.set(qn("w:type"), "dxa")
        tw.set(qn("w:w"), str(int(sum(widths_cm) * 567)))
        insert_ordered(tblPr, tw, TBLPR_ORDER)
        layout = OxmlElement("w:tblLayout")
        layout.set(qn("w:type"), "fixed")
        insert_ordered(tblPr, layout, TBLPR_ORDER)
        mar = OxmlElement("w:tblCellMar")
        for side, val in (("top", 0), ("left", 60), ("bottom", 0), ("right", 60)):
            e = OxmlElement("w:" + side)
            e.set(qn("w:w"), str(val))
            e.set(qn("w:type"), "dxa")
            mar.append(e)
        insert_ordered(tblPr, mar, TBLPR_ORDER)
        grid = tbl.find(qn("w:tblGrid"))
        if grid is not None:
            for gc, w in zip(grid.findall(qn("w:gridCol")), widths_cm):
                gc.set(qn("w:w"), str(int(w * 567)))
        for row in table.rows:
            for cell, w in zip(row.cells, widths_cm):
                tcPr = cell._tc.get_or_add_tcPr()
                tcW = OxmlElement("w:tcW")
                tcW.set(qn("w:type"), "dxa")
                tcW.set(qn("w:w"), str(int(w * 567)))
                insert_ordered(tcPr, tcW, TCPR_ORDER)


# --------------------------------------------------------------------------------------
# 五、主流程
# --------------------------------------------------------------------------------------
def build():
    raw = MD_PATH.read_bytes()
    import hashlib
    md_info = {
        "md_bytes": len(raw),
        "md_sha256_16": hashlib.sha256(raw).hexdigest()[:16],
        "md_mtime": __import__("datetime").datetime.fromtimestamp(MD_PATH.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
    }
    md = raw.decode("utf-8")
    blocks = parse_markdown(md)
    b = Builder()

    pending_fig = None
    in_caption = False
    for blk in blocks:
        t = blk["type"]
        if t == "heading":
            b.add_heading(blk["level"], blk["text"])
            in_caption = False
        elif t == "para":
            m = re.fullmatch(r"\u3010\u63d2\u5165\u56fe(\d)\u3011", blk["text"].strip())
            if m:
                b.add_figure(int(m.group(1)))
                pending_fig = int(m.group(1))
                in_caption = False
            elif re.match(r"^图注：", blk["text"].strip()):
                text = blk["text"].strip()
                text = re.sub(r"^图注：\s*", "", text)
                b.add_caption(text)
                pending_fig = None
                in_caption = True
            else:
                b.add_para(blk["text"])
                in_caption = False
        elif t == "bullet":
            if in_caption:
                b.add_caption_item(blk["text"])
            else:
                b.add_bullet(blk["text"])
        elif t == "number":
            if in_caption:
                b.add_caption_item(blk["text"], blk["marker"])
            else:
                b.add_number(blk["marker"], blk["text"])
        elif t == "code":
            b.add_code(blk["lines"])
            in_caption = False
        elif t == "math":
            b.add_math(blk["tex"])
            in_caption = False
        elif t == "table":
            b.add_table(blk["rows"])
            in_caption = False
        # hr 忽略

    b.doc.save(str(OUT_DOCX))
    return b, blocks, md_info


def self_check():
    """重新打开 docx 做实测统计。"""
    res = {}
    doc = Document(str(OUT_DOCX))
    res["paragraphs"] = len(doc.paragraphs)
    res["tables"] = len(doc.tables)
    res["inline_images"] = len(doc.inline_shapes)
    res["sections"] = len(doc.sections)
    with zipfile.ZipFile(str(OUT_DOCX)) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    res["omml_oMath"] = len(re.findall(r"<m:oMath[ >]", xml))
    res["drawings"] = xml.count("<w:drawing>")
    # 残留检查
    zh = "".join(p.text for p in doc.paragraphs)
    for tb in doc.tables:
        for row in tb.rows:
            for c in row.cells:
                zh += c.text
    res["leftover"] = {
        "$$": zh.count("$$") + xml.count("$$"),
        r"\frac": zh.count("\\frac") + xml.count("\\frac"),
        r"\begin{": zh.count("\\begin{") + xml.count("\\begin{"),
        r"\theta": zh.count("\\theta") + xml.count("\\theta"),
        r"\hat": zh.count("\\hat") + xml.count("\\hat"),
    }
    res["text_chars"] = len(zh)
    res["docx_bytes"] = OUT_DOCX.stat().st_size
    return res


def to_pdf():
    if not (os.path.exists(LO_NODE) and os.path.exists(LO_CLI)):
        return {"pdf_ok": False, "reason": "libreoffice kit not found"}
    cmd = [LO_NODE, LO_CLI, "convert", "--input", str(OUT_DOCX), "--output", str(OUT_PDF)]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = {"pdf_ok": r.returncode == 0 and OUT_PDF.exists(), "returncode": r.returncode,
           "stdout": (r.stdout or "")[-800:], "stderr": (r.stderr or "")[-800:]}
    if OUT_PDF.exists():
        out["pdf_bytes"] = OUT_PDF.stat().st_size
        try:
            from pypdf import PdfReader
            out["pdf_pages"] = len(PdfReader(str(OUT_PDF)).pages)
        except Exception as e:  # pragma: no cover
            out["pdf_pages"] = "err: %s" % e
    return out


def main():
    do_pdf = "--no-pdf" not in sys.argv
    b, blocks, md_info = build()
    summary = {
        "docx": str(OUT_DOCX),
        "pdf": str(OUT_PDF),
        "md_info": md_info,
        "blocks": len(blocks),
        "blocks_by_type": {t: sum(1 for x in blocks if x["type"] == t) for t in
                           sorted({x["type"] for x in blocks})},
        "omml_written": b.omml_total,
        "omml_failed": len(b.omml_failed),
        "figures": [{"idx": i, "file": f} for i, f in b.figures_inserted],
        "check": self_check(),
    }
    if do_pdf:
        summary["pdf_info"] = to_pdf()
    print(json.dumps(summary, ensure_ascii=True, indent=1))


if __name__ == "__main__":
    main()
