#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
@Project : anntoconfig
@File : exception.py
@Author : annto-dev
@Date : 2025/11/14 10:03
"""


class EnvNameSettingError(Exception):
    def __init__(self, message: str = None):
        if not message:
            message = "请设置环境变量ENV_NAME，或者在application.yaml设置'env_name'，可选[sit/ver/uat/prod]"
        self.message = message
        super().__init__(message)
