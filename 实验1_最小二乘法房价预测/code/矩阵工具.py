# -*- coding: utf-8 -*-
"""
最小二乘法核心工具（手写实现，不依赖现成求解器）
================================================================
本模块提供三个函数：

    manual_inverse(M)          自行实现的矩阵求逆（高斯-约当消元 + 列选主元）
    normal_equation_fit(A, y)  按正规方程求 θ = (AᵀA)⁻¹Aᵀy
    mse(y, y_hat)              均方误差

实验任务 3 明确禁止使用 np.linalg.inv() / np.linalg.solve() / np.linalg.lstsq()，
所以这里全程只用 numpy 的基础数组运算（@、切片、除法、绝对值、argmax）来实现，
再与 numpy 的结果对照自检。

单独运行本文件可以做一次 2×2 矩阵求逆的自测：
    python 矩阵工具.py
"""

import numpy as np


def manual_inverse(M, verbose=True):
    """
    自行实现的矩阵求逆：高斯-约当（Gauss-Jordan）消元法。

    思路：对增广矩阵 [M | I] 做初等行变换，把左边化成单位阵，
          右边就自动变成了 M⁻¹。

        ① 列选主元（部分主元）：在第 k 列的第 k 行及以下，挑绝对值最大的那一行
           交换到第 k 行，避免用接近 0 的数当除数（否则误差会被放大）；
        ② 主元行归一化：整行除以主元，使 aug[k, k] = 1；
        ③ 消元：用主元行把第 k 列其它行都消成 0（上下都消，即约当消元）。

    参数：
        M : 方阵（list 或 np.ndarray 都行）
    返回：
        (M⁻¹, 变换后的增广矩阵)
    """
    M = np.array(M, dtype=float)
    n = M.shape[0]
    if M.ndim != 2 or M.shape[0] != M.shape[1]:
        raise ValueError("只有方阵才能求逆")

    aug = np.hstack([M, np.eye(n)])            # 增广矩阵 [M | I]

    for k in range(n):
        # ① 选主元：找第 k 列中绝对值最大的行
        p = k + int(np.argmax(np.abs(aug[k:, k])))
        if abs(aug[p, k]) < 1e-12:
            raise np.linalg.LinAlgError("矩阵奇异（或接近奇异），不可求逆")
        if p != k:
            aug[[k, p], :] = aug[[p, k], :]    # 交换两行

        # ② 主元行归一化
        aug[k, :] = aug[k, :] / aug[k, k]

        # ③ 消去同列其它行
        for i in range(n):
            if i != k and aug[i, k] != 0.0:
                aug[i, :] = aug[i, :] - aug[i, k] * aug[k, :]

    if verbose:
        print(f"    手写求逆完成：{n}×{n} 矩阵，高斯-约当消元 + 列选主元")
    return aug[:, n:], aug


def normal_equation_fit(A, y, verbose=False):
    """
    正规方程法求最小二乘解：θ = (AᵀA)⁻¹Aᵀy

    返回 (θ, AᵀA, Aᵀy, (AᵀA)⁻¹)
    """
    AtA = A.T @ A
    Aty = A.T @ y
    inv_AtA, _ = manual_inverse(AtA, verbose=verbose)
    theta = inv_AtA @ Aty
    return theta, AtA, Aty, inv_AtA


def mse(y, y_hat):
    """均方误差 MSE = (1/n)Σ(yᵢ − ŷᵢ)²"""
    e = np.asarray(y, dtype=float) - np.asarray(y_hat, dtype=float)
    return float(np.mean(e ** 2))


if __name__ == "__main__":
    print("矩阵求逆自测：")
    A = np.array([[4.0, 7.0], [2.0, 6.0]])
    print("A =", A.tolist())
    invA, _ = manual_inverse(A, verbose=False)
    print("手写求逆 A⁻¹ =", invA.tolist())
    print("numpy  A⁻¹ =", np.linalg.inv(A).tolist())
    print("A⁻¹·A =\n", invA @ A)
    print("与 numpy 最大差异 =", np.max(np.abs(invA - np.linalg.inv(A))))

    # 教科书答案：[[0.6, -0.7], [-0.2, 0.4]]
    assert np.allclose(invA, [[0.6, -0.7], [-0.2, 0.4]]), "2×2 求逆结果不符合教科书答案"
    print("✓ 与教科书答案 [[0.6, -0.7], [-0.2, 0.4]] 一致")

    # 更大的随机矩阵，验证求逆精度
    rng = np.random.default_rng(0)
    for n in (3, 5, 10):
        M = rng.normal(size=(n, n)) + np.eye(n) * n
        Mi, _ = manual_inverse(M, verbose=False)
        err = np.max(np.abs(Mi - np.linalg.inv(M)))
        print(f"  {n}×{n} 随机矩阵求逆误差 = {err:.3e}")
        assert err < 1e-9
    print("✓ 全部通过")
