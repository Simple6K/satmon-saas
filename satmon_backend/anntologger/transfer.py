#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
@Project : anntologger
@File : transfer.py
@Author : annto-dev
@Date : 2025/10/23 10:18
"""
import logging

from log import InterceptHandler

def logger_transfer(logger:logging.Logger):
    logger.handlers= [InterceptHandler()]

