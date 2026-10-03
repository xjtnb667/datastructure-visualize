# -*- coding: utf-8 -*-
"""
任务 6：结果可视化
================================================================
绘制两张图：

  图 1（任务 6 要求）：
        横轴 GrLivArea（面积）、纵轴 SalePrice（价格），
        同一张图里既有原始数据的散点，也有最小二乘拟合出来的直线。

  图 2（补充分析）：
        特征与目标的散点图 + 各特征与目标的相关性，
        用来说明「为什么只用一个特征时 R² 不高」，
        以及换一个与房价线性关系更强的特征会发生什么。

运行方式（在 code 目录下）：
    python 02_绘图.py
"""

import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")                       # 无界面后端，直接存图片文件
import matplotlib.pyplot as plt
import numpy as np

BASE = Path(__file__).resolve().parent.parent
OUT = BASE / "results"

# ---------------------------------------------------------------------------
# 中文字体设置（否则图上的中文会变成方框）
# ---------------------------------------------------------------------------
matplotlib.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DengXian"]
matplotlib.rcParams["axes.unicode_minus"] = False

with open(OUT / "结果汇总.json", encoding="utf-8") as f:
    R = json.load(f)

data = np.load(OUT / "基础模型数据.npz")
x, y, y_hat, theta = data["x"], data["y"], data["y_hat"], data["theta"]

x_col = R["task1"]["特征列"]
y_col = R["task1"]["目标列"]
LAB_X = R["task1"]["x标签"]
LAB_Y = R["task1"]["y标签"]


# ===========================================================================
# 图 1：原始数据散点 + 最小二乘拟合直线（任务 6 的核心要求）
# ===========================================================================
def figure1():
    fig, ax = plt.subplots(figsize=(9, 5.8), dpi=150)

    # ① 原始房价数据散点图（全部样本）
    ax.scatter(x, y, s=4, alpha=0.20, color="#4C78A8",
               label=f"原始数据散点（{len(x)} 个样本）", zorder=2)

    # ② 最小二乘拟合直线（画在数据实际覆盖的范围内，不无意义地外推）
    x_hi = np.percentile(x, 99.5)
    xs = np.linspace(x.min(), x_hi, 100)
    ax.plot(xs, theta[0] + theta[1] * xs, color="#E45756", linewidth=2.6,
            label=f"最小二乘拟合直线\nŷ = {theta[0]:.4f} + {theta[1]:.4f}·x", zorder=3)

    # ③ 任务 5 的待预测点（1000/1500/2000 远超数据范围，画在数据上方示意"在数据范围之外"）
    y_star = 5.35
    # 三个点在 x 轴上挨得很近（1000/1500/2000），标注上下错开，避免文字互相压住
    offsets = [(-14, 6), (0, 24), (14, 42)]
    for item, (dx, dy) in zip(R["task5"], offsets):
        a, p = item["GrLivArea"], item["预测房价"]
        ax.plot([a], [y_star], marker="*", markersize=15, color="#F2A51A",
                markeredgecolor="#7A5C00", zorder=5)
        ax.annotate(f"ŷ={p:.1f}", xy=(a, y_star), xytext=(dx, dy),
                    textcoords="offset points", ha="center", va="bottom",
                    fontsize=8.5, color="#7A5C00",
                    arrowprops=dict(arrowstyle="-", color="#C79A2E",
                                    linewidth=0.8, shrinkA=0, shrinkB=2))
    ax.plot([], [], marker="*", markersize=13, color="#F2A51A",
            markeredgecolor="#7A5C00", linestyle="None",
            label="任务 5 待预测的新房屋（1000/1500/2000，\n落在数据范围之外，仅示意）")

    ax.set_xlabel(LAB_X, fontsize=11)
    ax.set_ylabel(LAB_Y, fontsize=11)
    ax.set_title("图 1  房价原始数据散点图 + 最小二乘拟合直线", fontsize=13, pad=12)
    ax.legend(fontsize=9.5, loc="upper left", framealpha=0.92)
    ax.grid(alpha=0.28, linestyle="--", which="both")
    ax.set_ylim(-0.5, 7.1)
    # 横轴用对数刻度：数据在 0.85~14 之间高度稠密，而任务 5 的 1000/1500/2000 远在右侧，
    # 只有对数轴才能在一张图里同时看清"密集的数据云"和"远处的待预测点"。
    ax.set_xscale("log")
    ax.set_xlim(x.min() * 0.9, 3400)

    # ---------- 内嵌图：放大数据最密集的区间，看清散点与拟合直线的走向 ----------
    axin = ax.inset_axes([0.30, 0.41, 0.46, 0.32])
    x_lo2, x_hi2 = np.percentile(x, 0.5), np.percentile(x, 99.4)
    m = (x >= x_lo2) & (x <= x_hi2)
    axin.scatter(x[m], y[m], s=3, alpha=0.22, color="#4C78A8")
    xs2 = np.linspace(x_lo2, x_hi2, 50)
    axin.plot(xs2, theta[0] + theta[1] * xs2, color="#E45756", linewidth=2)
    axin.set_xlim(x_lo2, x_hi2)
    axin.set_ylim(0, y.max() * 1.02)
    axin.tick_params(labelsize=7)
    axin.grid(alpha=0.25, linestyle=":")
    axin.set_title("局部放大：约 99% 的样本落在横轴 "
                   f"{x_lo2:.1f} ~ {x_hi2:.1f} 之间", fontsize=7.5, pad=3)

    ax.annotate(f"注：{y_col} 的取值上限被截断在 {y.max():.5f}；"
                f"横轴最大值 {x.max():.1f} 属于极端离群样本",
                xy=(0.985, 0.10), xycoords="axes fraction",
                ha="right", va="bottom", fontsize=8.5, color="#666666")

    fig.tight_layout()
    path = OUT / "图1_散点与最小二乘拟合直线.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"    已保存 -> results/{path.name}")
    return path


# ===========================================================================
# 图 2：特征对比（为什么单特征 R² 偏低）
# ===========================================================================
def figure2():
    import pandas as pd
    from 数据读取 import load_housing

    _, df = load_housing(verbose=False)

    feats = ["AveRooms", "MedInc", "HouseAge", "AveBedrms", "AveOccup", "Population"]
    fig, axes = plt.subplots(2, 3, figsize=(14, 8), dpi=140)

    for ax, col in zip(axes.ravel(), feats):
        xv = df[col].to_numpy(dtype=float)
        yv = df[y_col].to_numpy(dtype=float)

        ax.scatter(xv, yv, s=2.5, alpha=0.12, color="#72B7B2")
        ax.set_xlabel(col, fontsize=10)
        ax.set_ylabel(y_col, fontsize=10)

        # 用最小二乘拟合一条直线，直观看出线性关系强弱
        A = np.column_stack([np.ones_like(xv), xv])
        th = np.linalg.lstsq(A, yv, rcond=None)[0]
        xs = np.linspace(xv.min(), np.percentile(xv, 99), 50)
        ax.plot(xs, th[0] + th[1] * xs, color="#E45756", linewidth=2)

        r = np.corrcoef(xv, yv)[0, 1]
        r2 = r ** 2
        ax.set_title(f"{col}：r = {r:.3f}，单特征 R² = {r2:.3f}",
                     fontsize=10.5, color="#333333")
        ax.grid(alpha=0.25, linestyle="--")
        if col in ("AveRooms", "AveOccup", "Population"):
            ax.set_xlim(xv.min(), np.percentile(xv, 99))

    fig.suptitle("图 2  各特征与房价的线性关系（看斜率方向与 R² 大小）",
                 fontsize=13.5, y=0.98)
    fig.tight_layout(rect=[0, 0, 1, 0.96])
    path = OUT / "图2_各特征与房价的关系.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"    已保存 -> results/{path.name}")
    return path


# ===========================================================================
# 图 3：模型对比条形图（基础模型 vs 多特征扩展模型）
# ===========================================================================
def figure3():
    ext_path = OUT / "扩展结果.json"
    if not ext_path.exists():
        print("    （还没跑扩展任务，跳过图 3；请先运行 03_扩展任务_多特征.py）")
        return None

    with open(ext_path, encoding="utf-8") as f:
        E = json.load(f)

    names = ["一元模型\n（单特征）", "多元模型\n（多特征）"]
    mse = [R["task4"]["MSE"], E["MSE"]]
    r2 = [R["task4"]["R2"], E["R2"]]

    fig, axes = plt.subplots(1, 2, figsize=(10, 4.4), dpi=150)

    bars0 = axes[0].bar(names, mse, color=["#4C78A8", "#54A24B"], width=0.55)
    axes[0].set_ylabel("MSE（越小越好）", fontsize=11)
    axes[0].set_title("均方误差 MSE 对比", fontsize=12)
    for b, v in zip(bars0, mse):
        axes[0].text(b.get_x() + b.get_width() / 2, v, f"{v:.4f}",
                     ha="center", va="bottom", fontsize=10.5)

    bars1 = axes[1].bar(names, r2, color=["#4C78A8", "#54A24B"], width=0.55)
    axes[1].set_ylabel("R²（越大越好）", fontsize=11)
    axes[1].set_title("拟合优度 R² 对比", fontsize=12)
    for b, v in zip(bars1, r2):
        axes[1].text(b.get_x() + b.get_width() / 2, v, f"{v:.4f}",
                     ha="center", va="bottom", fontsize=10.5)
    axes[1].set_ylim(0, max(r2) * 1.25)

    for ax in axes:
        ax.grid(alpha=0.25, axis="y", linestyle="--")

    fig.suptitle("图 3  一元最小二乘模型与多特征模型的误差对比", fontsize=13, y=0.99)
    fig.tight_layout(rect=[0, 0, 1, 0.93])
    path = OUT / "图3_模型对比.png"
    fig.savefig(path)
    plt.close(fig)
    print(f"    已保存 -> results/{path.name}")
    return path


if __name__ == "__main__":
    print("任务 6：绘制图形")
    p1 = figure1()
    print("补充分析图：")
    p2 = figure2()
    print("模型对比图：")
    p3 = figure3()
    print("\n绘图完成。")
