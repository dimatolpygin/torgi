import pino from 'pino';

// Логи на русском, читаемые, с датой/временем. По правилам проекта.
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'dd.mm.yyyy HH:MM:ss',
      ignore: 'pid,hostname',
    },
  },
});

export default logger;
