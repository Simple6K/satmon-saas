import logging

try:
    from anntologger import Logger as AnntoLogger

    logger = AnntoLogger.getLogger("satmon_backend")
except ImportError:
    logger = logging.getLogger("satmon_backend")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
        )
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
