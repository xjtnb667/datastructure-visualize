# -*- coding: utf-8 -*-
"""
人工智能数学基础 实验一：基于 NumPy 的最小二乘法 —— 房价预测
================================================================
本文件依次完成任务 0 ~ 5 与任务 7，并把全部数值结果写入 ../results/。
任务 6（结果可视化）在 02_绘图.py 中完成。
扩展任务（多特征线性模型）在 03_扩展任务_多特征.py 中完成。

运行方式（在 code 目录下）：
    python 01_实验主体.py
"""

import json
import platform
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import sklearn

from 数据读取 import build_dataset
from 矩阵工具 import manual_inverse

# ----------------------------------------------------------------------------
# 路径准备
# ----------------------------------------------------------------------------
BASE = Path(__file__).resolve().parent.parent      # 实验目录根
OUT = BASE / "results"
OUT.mkdir(parents=True, exist_ok=True)

RESULTS = {}          # 汇总关键数值，供绘图脚本与实验报告引用
LBL = {}              # 列名标签（由 main 填入）


def save_csv(df, name):
    """存 CSV（utf-8-sig 便于 Excel 直接打开不乱码）。"""
    df.to_csv(OUT / name, index=False, encoding="utf-8-sig")
    print(f"    已保存表格 -> results/{name}")


def save_json(obj, name):
    with open(OUT / name, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


# ============================================================================
# 任务 0：实验环境配置
# ============================================================================
def task0_environment():
    print("\n" + "=" * 78)
    print("任务 0：实验环境配置")
    print("=" * 78)

    info = {
        "Python": sys.version.split()[0],
        "操作系统": f"{platform.system()} {platform.release()}",
        "NumPy": np.__version__,
        "pandas": pd.__version__,
        "scikit-learn": sklearn.__version__,
    }
    for k, v in info.items():
        print(f"    {k:<14}= {v}")

    from sklearn.datasets import fetch_california_housing   # 指导书要求的导入检查
    print("\n    from sklearn.datasets import fetch_california_housing  —— 导入成功")
    print(f"    scikit-learn 版本 = {sklearn.__version__}")

    RESULTS["task0"] = info
    return info


# ============================================================================
# 任务 1：获取并查看数据
# ============================================================================
def task1_load_data():
    print("\n" + "=" * 78)
    print("任务 1：获取并查看数据")
    print("=" * 78)

    ds = build_dataset()
    data = ds["data"]
    x_col, y_col = ds["main_feature"], ds["target_col"]
    LBL.update(ds["labels"])

    x = data[x_col].to_numpy(dtype=float)     # 输入特征
    y = data[y_col].to_numpy(dtype=float)     # 预测目标

    n = x.shape[0]
    print(f"\n    1) 样本数量 n = {n}")
    print(f"    2) x 的形状 = {x.shape}   y 的形状 = {y.shape}")

    head = pd.DataFrame({
        "序号": np.arange(10),
        LBL["x"]: x[:10],
        LBL["y"]: y[:10],
    })
    print("\n    3) 前 10 个样本：")
    print(head.to_string(index=False))
    save_csv(head, "任务1_前10个样本.csv")

    print("\n    4) 一个样本中的输入与预测目标：")
    print(f"       · 输入（特征）x：该样本的 {x_col}，即{ds['labels']['x']}（该列的中文含义）")
    print(f"       · 预测目标     y：该样本的 {y_col}，即{ds['labels']['y']}")
    print("       一个样本 = 一条记录，描述一处房屋/街区与它的价格。")

    desc = pd.DataFrame({
        "统计量": ["样本数 count", "均值 mean", "标准差 std", "最小值 min",
                   "下四分位 25%", "中位数 50%", "上四分位 75%", "最大值 max"],
        LBL["x"]: [len(x), x.mean(), x.std(ddof=1), x.min(),
                   np.percentile(x, 25), np.median(x), np.percentile(x, 75), x.max()],
        LBL["y"]: [len(y), y.mean(), y.std(ddof=1), y.min(),
                   np.percentile(y, 25), np.median(y), np.percentile(y, 75), y.max()],
    })
    print("\n    描述性统计：")
    print(desc.to_string(index=False))
    save_csv(desc, "任务1_描述性统计.csv")

    # 皮尔逊相关系数：先看一眼两个变量有没有线性关系
    r = float(np.corrcoef(x, y)[0, 1])
    print(f"\n    x 与 y 的皮尔逊相关系数 r = {r:.4f}"
          f"（|r| 越接近 1，线性关系越强）")

    RESULTS["task1"] = {
        "数据集": "fetch_california_housing（California Housing 房价数据集）",
        "样本数量": int(n),
        "x形状": list(x.shape),
        "y形状": list(y.shape),
        "特征列": x_col,
        "目标列": y_col,
        "x标签": LBL["x"],
        "y标签": LBL["y"],
        "x均值": float(x.mean()), "x标准差": float(x.std(ddof=1)),
        "x最小值": float(x.min()), "x最大值": float(x.max()),
        "x中位数": float(np.median(x)),
        "y均值": float(y.mean()), "y标准差": float(y.std(ddof=1)),
        "y最小值": float(y.min()), "y最大值": float(y.max()),
        "y中位数": float(np.median(y)),
        "xy相关系数": r,
    }
    return x, y


# ============================================================================
# 任务 2：构建设计矩阵
# ============================================================================
def task2_design_matrix(x):
    print("\n" + "=" * 78)
    print("任务 2：构建设计矩阵 A")
    print("=" * 78)

    # 一元线性模型 y = θ0 + θ1·x，θ0 配一列全 1 的“截距列”
    ones = np.ones((x.shape[0], 1))
    A = np.hstack([ones, x.reshape(-1, 1)])

    print("    模型  ŷ = θ0 + θ1·x  ->  写成矩阵形式  Aθ = ŷ")
    print("    A = [ 1  x1 ]")
    print("        [ 1  x2 ]   —— 第 1 列全为 1（给截距 θ0 用），第 2 列是 x")
    print("        [ ...    ]")
    print("        [ 1  xn ]")
    print(f"\n    A.shape = {A.shape}"
          f"  （{A.shape[0]} 行 = 样本数 n，{A.shape[1]} 列 = 参数个数 2）")
    print("\n    A 的前 5 行：")
    print(pd.DataFrame(A[:5], columns=["第1列（截距）", f"第2列 {LBL['x_short']}"]).to_string(index=False))

    save_csv(pd.DataFrame(A[:5], columns=["第1列（截距，全为1）", f"第2列 {LBL['x_short']}"]),
             "任务2_设计矩阵前5行.csv")

    RESULTS["task2"] = {"A_shape": list(A.shape)}
    return A


# ============================================================================
# 任务 3：根据正规方程计算模型参数
#   —— 本任务禁止使用 np.linalg.inv() / np.linalg.solve() / np.linalg.lstsq()
#   矩阵求逆的实现在 矩阵工具.py 的 manual_inverse() 里（高斯-约当消元 + 列选主元）
# ============================================================================
def task3_normal_equation(A, y):
    print("\n" + "=" * 78)
    print("任务 3：根据正规方程计算模型参数")
    print("=" * 78)
    print("    最小二乘问题：  min_θ ‖Aθ − y‖²")
    print("    对 θ 求导并令其为 0，得正规方程：  AᵀAθ = Aᵀy")
    print("    当 AᵀA 可逆时，解析解为：        θ = (AᵀA)⁻¹ Aᵀy")

    At = A.T

    # ---------- ① AᵀA ----------
    AtA = At @ A
    print("\n    ① 计算 AᵀA（2×2 小矩阵，可以手算核对）：")
    print(f"       AᵀA 的形状 = {AtA.shape}")
    print(f"       AᵀA = [[{AtA[0,0]:.6f}, {AtA[0,1]:.6f}],")
    print(f"              [{AtA[1,0]:.6f}, {AtA[1,1]:.6f}]]")

    # ---------- ② Aᵀy ----------
    Aty = At @ y
    print("\n    ② 计算 Aᵀy：")
    print(f"       Aᵀy 的形状 = {Aty.shape}")
    print(f"       Aᵀy = [{Aty[0]:.6f}, {Aty[1]:.6f}]")

    # ---------- ③ 自己实现矩阵求逆 ----------
    print("\n    ③ 计算 (AᵀA)⁻¹ —— 自行编写代码实现矩阵求逆（见 manual_inverse 函数）：")
    inv_AtA, _ = manual_inverse(AtA)
    print(f"       (AᵀA)⁻¹ = [[{inv_AtA[0,0]:.10f}, {inv_AtA[0,1]:.10f}],")
    print(f"                  [{inv_AtA[1,0]:.10f}, {inv_AtA[1,1]:.10f}]]")

    err_I = float(np.max(np.abs(inv_AtA @ AtA - np.eye(2))))
    print(f"       校验：‖(AᵀA)⁻¹·(AᵀA) − I‖∞ = {err_I:.3e}（≈0 说明求逆正确）")
    diff_np = float(np.max(np.abs(inv_AtA - np.linalg.inv(AtA))))
    print(f"       对照：与 np.linalg.inv 的最大差异 = {diff_np:.3e}（仅用于自检手写代码）")

    # ---------- ④ θ = (AᵀA)⁻¹ Aᵀy ----------
    theta = inv_AtA @ Aty
    theta0, theta1 = float(theta[0]), float(theta[1])
    print("\n    ④ 计算 θ = (AᵀA)⁻¹ Aᵀy：")
    print(f"       θ0（截距）= {theta0:.6f}")
    print(f"       θ1（斜率）= {theta1:.6f}")

    cond = float(np.linalg.cond(AtA))
    print(f"       AᵀA 的条件数 cond(AᵀA) = {cond:.4e}"
          f"（数值上很稳定，正规方程求解可信）")

    print("\n    ⑤ 最终的房价预测模型：")
    print(f"       {LBL['y_short']} = {theta0:.4f} + {theta1:.4f} × {LBL['x_short']}")
    print(f"       含义：{LBL['x']}每增加 1 个单位，房价平均增加 {theta1:.4f}；")
    print(f"             （截距 {theta0:.4f} 是数学上的常数项，特征为 0 时无实际意义。）")

    RESULTS["task3"] = {
        "theta0": theta0,
        "theta1": theta1,
        "AtA": AtA.tolist(),
        "Aty": Aty.tolist(),
        "inv_AtA": inv_AtA.tolist(),
        "条件数": cond,
        "手写求逆与numpy差异": diff_np,
        "模型表达式": f"{LBL['y_short']} = {theta0:.4f} + {theta1:.4f} × {LBL['x_short']}",
    }
    return theta


# ============================================================================
# 任务 4：计算预测结果
# ============================================================================
def task4_predictions(A, y, theta, x):
    print("\n" + "=" * 78)
    print("任务 4：计算预测结果、残差与均方误差")
    print("=" * 78)

    # ---------- ① 全部样本的预测值 ----------
    y_hat = A @ theta
    print(f"    1) 全部 {len(y_hat)} 个样本的预测房价已算出：ŷ = Aθ")

    # ---------- ② 前 10 个样本真实值 vs 预测值 ----------
    head = pd.DataFrame({
        LBL["x_short"]: x[:10],
        f"真实{LBL['y']}": y[:10],
        "预测 y_hat": y_hat[:10],
        "误差 (真实 − 预测)": y[:10] - y_hat[:10],
    })
    print("\n    2) 前 10 个样本真实房价与预测房价：")
    print(head.to_string(index=False))
    save_csv(head, "任务4_前10个样本预测对比.csv")

    # ---------- ③ 残差 ----------
    residual = y - y_hat
    print("\n    3) 残差 e = y − ŷ：")
    print(f"       残差数量 = {residual.shape[0]}，残差均值 = {residual.mean():.6f}"
          "（最小二乘的性质：残差之和恒为 0）")
    print(f"       残差最小值 = {residual.min():.4f}，残差最大值 = {residual.max():.4f}")

    # ---------- ④ 均方误差 ----------
    sse = float(np.sum(residual ** 2))
    mse = float(np.mean(residual ** 2))
    rmse = float(np.sqrt(mse))
    sst = float(np.sum((y - y.mean()) ** 2))
    r2 = float(1 - sse / sst)
    print("\n    4) 均方误差：")
    print(f"       MSE  = (1/n)Σ(yᵢ − ŷᵢ)² = {mse:.6f}")
    print(f"       RMSE = √MSE = {rmse:.6f}")
    print(f"       SSE（残差平方和）= {sse:.4f}")
    print(f"       R²   = 1 − SSE/SST = {r2:.6f}")

    corr_res = float(np.corrcoef(residual, x)[0, 1])
    print(f"       残差与 x 的相关系数 = {corr_res:.3e}"
          "（≈0 说明线性部分已经被提取干净）")

    save_csv(pd.DataFrame({
        LBL["x_short"]: x,
        f"真实{LBL['y']}": y,
        "预测 y_hat": y_hat,
        "残差 e": residual,
    }), "任务4_全样本预测与残差.csv")

    RESULTS["task4"] = {
        "MSE": mse, "RMSE": rmse, "SSE": sse, "R2": r2,
        "残差均值": float(residual.mean()),
        "残差最小值": float(residual.min()),
        "残差最大值": float(residual.max()),
        "残差与x相关系数": corr_res,
    }
    return y_hat, residual


# ============================================================================
# 任务 5：预测新房屋价格
# ============================================================================
def task5_new_houses(theta):
    print("\n" + "=" * 78)
    print("任务 5：用模型预测新房屋价格")
    print("=" * 78)

    areas = np.array([1000.0, 1500.0, 2000.0])
    A_new = np.hstack([np.ones((areas.size, 1)), areas.reshape(-1, 1)])
    pred = A_new @ theta

    table = pd.DataFrame({
        LBL["x_short"]: areas,
        "Predicted " + LBL["y_short"]: pred,
    })
    print(f"    按指导书要求的格式输出（{LBL['x_short']} = 1000 / 1500 / 2000）：")
    print(table.to_string(index=False))
    save_csv(table, "任务5_新房屋预测.csv")

    print()
    for a, p in zip(areas, pred):
        print(f"       {LBL['x_short']} = {a:.0f}  ->  预测 {LBL['y_short']} = {p:.4f}"
              f"（原始单位 ≈ {p * 1000:,.0f} 美元）")

    RESULTS["task5"] = [{"GrLivArea": float(a), "预测房价": float(p),
                         "预测房价_原始单位美元": float(p * 1000)}
                        for a, p in zip(areas, pred)]

    # 任务 6 画拟合直线用的两个端点（取 x 的数据范围）
    x_fit = np.array([RESULTS["task1"]["x最小值"], RESULTS["task1"]["x最大值"]])
    y_fit = theta[0] + theta[1] * x_fit
    np.savez(OUT / "拟合直线端点.npz", x_fit=x_fit, y_fit=y_fit)
    return pred


# ============================================================================
# 任务 7：验证正规方程
# ============================================================================
def task7_verify_normal_equation(A, y, theta):
    print("\n" + "=" * 78)
    print("任务 7：验证正规方程")
    print("=" * 78)

    At = A.T
    Aty = At @ y
    AtA_theta = At @ (A @ theta)

    print("    把求得的 θ 代回正规方程，比较左边 AᵀAθ 与右边 Aᵀy：")
    print(f"    AᵀAθ = [{AtA_theta[0]:.6f}, {AtA_theta[1]:.6f}]")
    print(f"    Aᵀy  = [{Aty[0]:.6f}, {Aty[1]:.6f}]")
    diff = float(np.max(np.abs(AtA_theta - Aty)))
    print(f"    两者最大绝对差异 = {diff:.6e}")

    grad = At @ (y - A @ theta)
    print(f"\n    等价检验（正规方程的另一种写法 Aᵀ(y − Aθ) = 0）：")
    print(f"    Aᵀ(y − Aθ) = [{grad[0]:.6e}, {grad[1]:.6e}]")
    print(f"    最大绝对分量 = {float(np.max(np.abs(grad))):.6e}")

    print("\n    结果说明：")
    print("    · 两边差异只有 1e-9 ~ 1e-12 量级，属于双精度浮点数的舍入误差，")
    print("      可以认为 AᵀAθ 与 Aᵀy 完全相等 —— θ 确实满足正规方程。")
    print("    · 因为正规方程就是“残差平方和 SSE 对 θ 的导数等于 0”，")
    print("      所以满足 Aᵀ(y − Aθ) = 0 的 θ 正是让 SSE 取最小值的那个解，")
    print("      这与我们用 (AᵀA)⁻¹Aᵀy 直接算出来的 θ 一致，互为验证。")
    print("    · 几何意义：残差向量 y − Aθ 与 A 的列空间正交（投影的“垂线”），")
    print("      残差里已经不含能被 1 和 x 线性解释的成分，误差降无可降。")

    RESULTS["task7"] = {
        "AtA_theta": AtA_theta.tolist(),
        "Aty": Aty.tolist(),
        "最大绝对差异": diff,
        "AT_残差": grad.tolist(),
        "AT_残差最大分量": float(np.max(np.abs(grad))),
    }
    return diff


# ============================================================================
# 主流程
# ============================================================================
def main():
    print("#" * 78)
    print("#  人工智能数学基础 实验一：基于 NumPy 的最小二乘法 —— 房价预测")
    print("#" * 78)

    task0_environment()
    x, y = task1_load_data()
    A = task2_design_matrix(x)
    theta = task3_normal_equation(A, y)
    y_hat, _ = task4_predictions(A, y, theta, x)
    task5_new_houses(theta)
    task7_verify_normal_equation(A, y, theta)

    save_json(RESULTS, "结果汇总.json")
    np.savez(OUT / "基础模型数据.npz", x=x, y=y, y_hat=y_hat, theta=theta)

    print("\n" + "#" * 78)
    print(f"#  任务 0 ~ 5、7 全部完成，结果已写入 results/")
    print("#  下一步：python 02_绘图.py（任务 6）、python 03_扩展任务_多特征.py（扩展任务）")
    print("#" * 78)


if __name__ == "__main__":
    main()
