# -*- coding: utf-8 -*-
"""
数据读取与特征解析模块
================================================================
本模块解决两件事：

一、兼容实验指导书的调用写法
    指导书原文：
        from sklearn.datasets import fetch_california_housing
        housing = fetch_california_housing(name="house_prices", as_frame=True)
        data = housing.frame
    `name="house_prices"` 这个参数只存在于较老的 scikit-learn 版本，新版本
    （本机 1.9.1）已移除，直接照抄会抛
        TypeError: got an unexpected keyword argument 'name'
    因此 load_housing() 先按原文尝试，不支持时自动回退到等价调用。

二、兼容“指导书里的列名”与“真实数据集的列名”
    指导书任务里用的列名是 GrLivArea（地上居住面积）和 SalePrice（成交价格），
    这套列名来自 Kaggle 的 Ames/房屋成交价格数据集，而
    fetch_california_housing 实际给出的列名是：

        MedInc  HouseAge  AveRooms  AveBedrms  Population
        AveOccup  Latitude  Longitude            -> 特征
        MedHouseVal                              -> 目标列

    两套名字对不上。resolve_feature() 的做法是：
      · 如果数据集里确实有指导书那个列名（比如你用的是 Ames 版数据文件），就直接用；
      · 没有则回退到本数据集里语义最接近、且与目标确实存在线性关系的列，
        并把“中文名 / 原列名 / 实际使用的列名 / 是否属于回退”一并记录下来，
        实验报告里照实写清楚，不含糊过去。
"""

import pandas as pd
from sklearn.datasets import fetch_california_housing

# ---------------------------------------------------------------------------
# 指导书列名 -> 本数据集中的候选列（按优先级排列）
# ---------------------------------------------------------------------------
FEATURE_CANDIDATES = {
    # 指导书：GrLivArea  # 地上居住面积
    "GrLivArea": ["GrLivArea", "AveRooms"],
    # 指导书：OverallQual  # 房屋整体质量
    "OverallQual": ["OverallQual", "MedInc"],
    # 指导书：YearBuilt    # 建造年份
    "YearBuilt": ["YearBuilt", "HouseAge"],
    # 指导书：1stFlrSF      # 一楼面积
    "1stFlrSF": ["1stFlrSF", "AveBedrms"],
    # 指导书：FullBath      # 全卫数量
    "FullBath": ["FullBath", "AveBedrms"],
    # 指导书：BedroomAbvGr  # 地上卧室数量
    "BedroomAbvGr": ["BedroomAbvGr", "AveBedrms"],
    # 指导书：TotRmsAbvGrd  # 地上房间总数
    "TotRmsAbvGrd": ["TotRmsAbvGrd", "AveRooms"],
    # 指导书：GarageCars    # 车库容量
    "GarageCars": ["GarageCars", "AveOccup"],
    # 指导书：LotArea       # 地块面积
    "LotArea": ["LotArea", "Population"],
}

TARGET_CANDIDATES = ["SalePrice", "MedHouseVal"]

# 中文含义对照（报告与图表里统一用）
CN_NAME = {
    "GrLivArea": "地上居住面积",
    "OverallQual": "房屋整体质量",
    "YearBuilt": "建造年份",
    "1stFlrSF": "一楼面积",
    "FullBath": "全卫数量",
    "BedroomAbvGr": "地上卧室数量",
    "TotRmsAbvGrd": "地上房间总数",
    "GarageCars": "车库容量",
    "LotArea": "地块面积",
    "AveRooms": "平均房间数",
    "MedInc": "街区收入中位数",
    "HouseAge": "房龄中位数",
    "AveBedrms": "平均卧室数",
    "AveOccup": "平均家庭人数",
    "Population": "街区人口",
    "SalePrice": "房屋成交价格",
    "MedHouseVal": "房屋价格中位数",
}


def load_housing(verbose=True):
    """返回 (housing_bunch, data_frame)。data 的每一行是一个样本。"""
    try:
        # 实验指导书原文写法（老版本 scikit-learn 有效）
        housing = fetch_california_housing(name="house_prices", as_frame=True)
        if verbose:
            print("    [数据读取] 使用实验指导书写法："
                  "fetch_california_housing(name='house_prices', as_frame=True)")
    except TypeError:
        # 新版 scikit-learn 已移除 name 参数，等价回退
        housing = fetch_california_housing(as_frame=True)
        if verbose:
            print("    [数据读取] 当前 scikit-learn 版本已移除 name 参数，")
            print("              自动回退到等价写法：fetch_california_housing(as_frame=True)")
    return housing, housing.frame


def resolve_column(data, guide_name, is_target=False, verbose=True):
    """把指导书列名解析成本数据集里真实存在的列名。"""
    candidates = TARGET_CANDIDATES if is_target else FEATURE_CANDIDATES[guide_name]
    for cand in candidates:
        if cand in data.columns:
            fallback = (cand != guide_name)
            if fallback and verbose:
                print(f"    [列名解析] 数据集中没有 {guide_name}（{CN_NAME[guide_name]}），"
                      f"回退使用 {cand}（{CN_NAME[cand]}）")
            return cand
    raise KeyError(f"数据集中找不到 {guide_name} 的任何候选列：{candidates}")


def display_name(guide_name, actual_col):
    """生成用于打印/表格/图表的列标题。"""
    if guide_name == actual_col:
        return f"{guide_name}（{CN_NAME[guide_name]}）"
    return f"{guide_name}（{CN_NAME[guide_name]}，实际用 {actual_col} {CN_NAME[actual_col]}）"


def build_dataset():
    """
    读数据、解析列名，返回一个字典：
        data        原始 DataFrame
        target_col  实际使用的目标列
        feature_cols 实际使用的特征列（列表）
        labels      显示用标签
    """
    housing, data = load_housing()
    target_col = resolve_column(data, "SalePrice", is_target=True)
    main_feature = resolve_column(data, "GrLivArea")
    return {
        "housing": housing,
        "data": data,
        "target_col": target_col,
        "main_feature": main_feature,
        "labels": {
            "x": display_name("GrLivArea", main_feature),
            "y": display_name("SalePrice", target_col),
            "x_short": "GrLivArea" if main_feature == "GrLivArea" else main_feature,
            "y_short": "SalePrice" if target_col == "SalePrice" else target_col,
        },
    }


if __name__ == "__main__":
    ds = build_dataset()
    print("\n解析结果：")
    print("  目标列 :", ds["target_col"], "->", ds["labels"]["y"])
    print("  主特征 :", ds["main_feature"], "->", ds["labels"]["x"])
    print("  样本数 :", len(ds["data"]))
    print("  全部列 :", list(ds["data"].columns))
