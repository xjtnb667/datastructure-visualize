# -*- coding: utf-8 -*-
"""
扩展任务：建立多特征线性模型
================================================================
指导书要求：从有效特征中自行选择不少于 3 个，建立多特征线性模型，
            并计算 MSE、与只用 GrLivArea 的模型比较。

本文件按正规方程 θ = (AᵀA)⁻¹Aᵀy 求解，矩阵求逆沿用 01_实验主体.py 里
自己实现的 manual_inverse()（只用基础数组运算），
没有使用 np.linalg.inv / solve / lstsq —— 扩展任务允许用，但不用更稳，
结果与 numpy 的求解器一致（下面打印了对照差异）。

运行方式（在 code 目录下）：
    python 03_扩展任务_多特征.py
"""

import json
from pathlib import Path

import numpy as np
import pandas as pd

from 数据读取 import build_dataset
from 矩阵工具 import manual_inverse

BASE = Path(__file__).resolve().parent.parent
OUT = BASE / "results"
OUT.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# 选用的 5 个特征（指导书给出的候选特征在本数据集中对应的列）
# ---------------------------------------------------------------------------
FEATURES = [
    ("MedInc", "街区收入中位数（≈ 房屋整体质量/地段档次的代理变量）"),
    ("AveRooms", "平均房间数（≈ 地上居住面积 / 房间总数的代理变量）"),
    ("HouseAge", "房龄中位数"),
    ("AveOccup", "平均家庭人数"),
    ("Population", "街区人口"),
]


def fit_normal_equation(A, y):
    """用正规方程求解 θ，矩阵求逆由自己实现。"""
    inv_AtA, _ = manual_inverse(A.T @ A, verbose=False)
    return inv_AtA @ (A.T @ y), inv_AtA


def main():
    print("#" * 78)
    print("#  扩展任务：多特征最小二乘模型")
    print("#" * 78)

    ds = build_dataset()
    data = ds["data"]
    y_col = ds["target_col"]

    # ---------- 1. 构造新的设计矩阵 ----------
    cols = [c for c, _ in FEATURES]
    X = data[cols].to_numpy(dtype=float)
    y = data[y_col].to_numpy(dtype=float)

    A = np.hstack([np.ones((X.shape[0], 1)), X])      # 第 1 列是截距列

    print("\n1) 构造新的设计矩阵 A：")
    print(f"   选用的特征（{len(cols)} 个）：")
    for i, (c, why) in enumerate(FEATURES, 1):
        print(f"     {i}. {c:<12} —— {why}")
    print(f"\n   A.shape = {A.shape}"
          f"  （{A.shape[0]} 个样本，{A.shape[1]} 列 = 1 个截距 + {len(cols)} 个特征）")
    print("   A 的前 5 行（第 1 列是截距）：")
    print(pd.DataFrame(A[:5], columns=["截距"] + cols).to_string(index=False))

    # ---------- 2. 计算模型参数 ----------
    theta, inv_AtA = fit_normal_equation(A, y)
    theta_np = np.linalg.lstsq(A, y, rcond=None)[0]      # 仅用于交叉验证

    print("\n2) 计算模型参数 θ = (AᵀA)⁻¹Aᵀy：")
    print(f"   θ0（截距）        = {theta[0]: .6f}")
    for c, t in zip(cols, theta[1:]):
        print(f"   θ（{c:<12}） = {t: .6f}")
    print(f"\n   条件数 cond(AᵀA) = {np.linalg.cond(A.T @ A):.4e}")
    print(f"   交叉验证：与 np.linalg.lstsq 的最大差异 = "
          f"{np.max(np.abs(theta - theta_np)):.3e}")

    # ---------- 3. 计算所有样本预测值 ----------
    y_hat = A @ theta
    residual = y - y_hat

    # ---------- 4. 计算 MSE（连同 R² 一起算，方便比较） ----------
    sse = float(np.sum(residual ** 2))
    mse = float(np.mean(residual ** 2))
    rmse = float(np.sqrt(mse))
    r2 = float(1 - sse / float(np.sum((y - y.mean()) ** 2)))

    print("\n3) 全部样本的预测值已算出（ŷ = Aθ）")
    print("4) 误差指标：")
    print(f"   MSE  = {mse:.6f}")
    print(f"   RMSE = {rmse:.6f}")
    print(f"   SSE  = {sse:.4f}")
    print(f"   R²   = {r2:.6f}")

    # ---------- 5. 与只用 GrLivArea 的模型比较 ----------
    with open(OUT / "结果汇总.json", encoding="utf-8") as f:
        base = json.load(f)

    base_mse, base_r2, base_rmse = base["task4"]["MSE"], base["task4"]["R2"], base["task4"]["RMSE"]

    comp = pd.DataFrame({
        "模型": ["一元模型（仅 1 个特征）", f"多元模型（{len(cols)} 个特征）"],
        "特征": [" / ".join([base["task1"]["特征列"]]), " / ".join(cols)],
        "MSE": [base_mse, mse],
        "RMSE": [base_rmse, rmse],
        "R²": [base_r2, r2],
    })
    print("\n5) 两个模型的比较：")
    print(comp.to_string(index=False))

    print(f"\n   MSE 下降：{base_mse:.6f} -> {mse:.6f}"
          f"（降低 {100 * (base_mse - mse) / base_mse:.2f}%，即降到原来的 "
          f"{100 * mse / base_mse:.2f}%）")
    print(f"   R²  提升：{base_r2:.6f} -> {r2:.6f}（提高 {r2 - base_r2:.6f}）")
    print("\n   结论：多特征模型明显优于单特征模型。")
    print("   原因：房价不只由房间数决定，收入水平（地段）、房龄等都会影响价格；")
    print("        单特征模型漏掉了这些信息，所以残差大、R² 低。")
    print("        每增加一个有效特征，就多一个可调节的自由度去逼近真实价格。")

    # ---------- 落盘 ----------
    comp.to_csv(OUT / "扩展_模型比较.csv", index=False, encoding="utf-8-sig")
    pd.DataFrame({
        "特征": cols,
        "系数 θ": theta[1:],
    }).to_csv(OUT / "扩展_回归系数.csv", index=False, encoding="utf-8-sig")

    np.savez(OUT / "扩展模型数据.npz", cols=np.array(cols), theta=theta,
             y_hat=y_hat, A_shape=np.array(A.shape))

    ext = {
        "特征": cols,
        "特征说明": [why for _, why in FEATURES],
        "theta": theta.tolist(),
        "截距": float(theta[0]),
        "MSE": mse, "RMSE": rmse, "SSE": sse, "R2": r2,
        "基础模型MSE": base_mse, "基础模型R2": base_r2,
        "MSE降低百分比": float(100 * (base_mse - mse) / base_mse),
        "R2提升": float(r2 - base_r2),
        "条件数": float(np.linalg.cond(A.T @ A)),
        "与lstsq最大差异": float(np.max(np.abs(theta - theta_np))),
        "模型表达式": f"{y_col} = " + " + ".join(
            [f"{theta[0]:.4f}"] + [f"({t:.4f})·{c}" for c, t in zip(cols, theta[1:])]),
    }
    with open(OUT / "扩展结果.json", "w", encoding="utf-8") as f:
        json.dump(ext, f, ensure_ascii=False, indent=2)

    print("\n   已保存 -> results/扩展结果.json、扩展_模型比较.csv、扩展_回归系数.csv")
    print("#" * 78)


if __name__ == "__main__":
    main()
