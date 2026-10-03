# -*- coding: utf-8 -*-
"""
补充分析：候选特征的“单特征一元回归”对比
================================================================
实验指导书指出：本数据集里没有 GrLivArea（地上居住面积）这一列，
所以主实验用了语义最接近的 AveRooms（平均房间数）作为替代。

但只用一个特征做一元回归时，R² 只有 0.023，模型解释能力很弱。
本文件把指导书给的其他候选特征也逐个做一次一元最小二乘回归，
把它们的 MSE / R² 摆在一起比较，用来回答两个问题：

  1. 为什么单特征模型误差大？（特征本身和目标的相关性弱）
  2. 换一个与房价线性关系更强的特征，一元模型能好多少？

全部用正规方程 θ = (AᵀA)⁻¹Aᵀy 求解，矩阵求逆仍用自己实现的 manual_inverse()。

运行方式（在 code 目录下）：
    python 04_单特征对比.py
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from 数据读取 import load_housing, CN_NAME
from 矩阵工具 import normal_equation_fit

BASE = Path(__file__).resolve().parent.parent
OUT = BASE / "results"

# 候选特征：指导书列名 -> 本数据集列名
CANDIDATES = [
    ("GrLivArea", "AveRooms"),
    ("OverallQual", "MedInc"),
    ("YearBuilt", "HouseAge"),
    ("FullBath", "AveBedrms"),
    ("GarageCars", "AveOccup"),
    ("LotArea", "Population"),
    ("Latitude", "Latitude"),
    ("Longitude", "Longitude"),
]


def main():
    print("#" * 78)
    print("#  补充分析：各候选特征的单特征一元最小二乘回归对比")
    print("#" * 78)

    _, df = load_housing(verbose=False)
    y = df["MedHouseVal"].to_numpy(dtype=float)
    sst = float(np.sum((y - y.mean()) ** 2))

    rows = []
    for guide_name, col in CANDIDATES:
        if col not in df.columns:
            continue
        x = df[col].to_numpy(dtype=float)
        A = np.hstack([np.ones((x.size, 1)), x.reshape(-1, 1)])
        theta, _, _, _ = normal_equation_fit(A, y)
        y_hat = A @ theta
        resid = y - y_hat
        sse = float(np.sum(resid ** 2))
        rows.append({
            "指导书列名": guide_name,
            "实际列名": col,
            "中文含义": CN_NAME.get(col, col),
            "θ0（截距）": theta[0],
            "θ1（斜率）": theta[1],
            "MSE": sse / y.size,
            "RMSE": np.sqrt(sse / y.size),
            "R²": 1 - sse / sst,
            "|相关系数|": abs(float(np.corrcoef(x, y)[0, 1])),
        })

    table = pd.DataFrame(rows).sort_values("R²", ascending=False).reset_index(drop=True)
    show = table.copy()
    for c in ["θ0（截距）", "θ1（斜率）", "MSE", "RMSE", "R²", "|相关系数|"]:
        show[c] = show[c].map(lambda v: f"{v: .6f}")
    print("\n   按 R² 从高到低排序：")
    print(show.to_string(index=False))

    best = table.iloc[0]
    print(f"\n   单特征里表现最好的是 {best['实际列名']}（{best['中文含义']}）："
          f"R² = {best['R²']:.4f}，MSE = {best['MSE']:.6f}")
    print(f"   主实验用的 AveRooms（平均房间数）："
          f"R² = {table.loc[table['实际列名'] == 'AveRooms', 'R²'].iloc[0]:.4f}")
    print("\n   说明：R² 低的根本原因是特征与房价的线性相关性弱，")
    print("        而不是最小二乘法算错了 —— 同一套正规方程代码，")
    print("        换成相关性强的特征，R² 立刻从 0.02 量级升到 0.4 量级。")

    table.to_csv(OUT / "补充_单特征回归对比.csv", index=False, encoding="utf-8-sig")

    summary = {
        "排序": table.to_dict(orient="records"),
        "最佳单特征": {
            "列名": best["实际列名"],
            "中文": best["中文含义"],
            "MSE": float(best["MSE"]),
            "R2": float(best["R²"]),
            "theta0": float(best["θ0（截距）"]),
            "theta1": float(best["θ1（斜率）"]),
        },
    }
    with open(OUT / "补充单特征对比.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("\n   已保存 -> results/补充_单特征回归对比.csv、补充单特征对比.json")
    print("#" * 78)


if __name__ == "__main__":
    main()
