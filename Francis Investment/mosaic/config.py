"""
Mosaic 量化引擎配置
"""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT_ENGINE_DIR = os.path.join(BASE_DIR, 'report-engine')
DATA_DIR = os.path.join(REPORT_ENGINE_DIR, 'data')

# ---- 筛选条件 ----
FILTER = {
    'max_price': 20.00,           # 股价上限
    'min_turnover': 100_000_000,  # 最低日成交额（1亿）
    'exclude_st': True,           # 排除ST
    'exclude_300': True,          # 排除创业板（300xxx）
    'exclude_688': False,         # 科创板默认排除（但可配置）
}

# ---- 因子权重 ----
FACTOR_WEIGHTS = {
    'fundamental': 0.25,    # 基本面
    'technical': 0.20,      # 技术面
    'hidden': 0.35,         # 隐藏因子（X-Factors）
    'capital_flow': 0.20,   # 资金面
}

# ---- 隐藏因子定义 ----
HIDDEN_FACTORS = {
    'X1': {'name': '高管集群增持', 'weight': 3, 'type': 'bullish'},
    'X2': {'name': '大宗交易溢价', 'weight': 3, 'type': 'bullish'},
    'X3': {'name': '融资断崖反转', 'weight': 2, 'type': 'bullish'},
    'X4': {'name': '股东户数骤降', 'weight': 3, 'type': 'bullish'},
    'X5': {'name': '问询函利空出尽', 'weight': 2, 'type': 'bullish'},
    'X6': {'name': '质押比例预警', 'weight': 3, 'type': 'bearish'},
    'X7': {'name': '北向持续加仓', 'weight': 3, 'type': 'bullish'},
    'X8': {'name': '龙虎榜机构对决', 'weight': 2, 'type': 'bullish'},
    'X9': {'name': '假减持真维稳', 'weight': 2, 'type': 'bullish'},
    'X10': {'name': '互动易催化信号', 'weight': 1, 'type': 'bullish'},
    'X11': {'name': '专利申报激增', 'weight': 1, 'type': 'bullish'},
    'X12': {'name': '员工持股安全垫', 'weight': 2, 'type': 'bullish'},
}

# ---- 模拟交易参数 ----
SIMFOLIO = {
    'initial_capital': 100_000,
    'max_positions': 5,
    'max_single_position_pct': 0.30,
    'stop_loss_pct': -0.08,
    'commission_rate': 0.00025,     # 佣金
    'stamp_tax_rate': 0.001,        # 印花税（卖出）
    'transfer_fee_rate': 0.00001,   # 过户费
}

# ---- 跟踪板块 ----
SECTORS = [
    '机器人/具身智能',
    '创新药/AI医疗',
    '半导体/AI算力',
    '商业航天',
    '固态电池/储能',
    '有色金属/稀土',
    '新型电力基建',
    '军工',
]
