const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const schedule = require('node-schedule');
const mysql = require('mysql2/promise');

const settingsPath = './settings.json';

module.exports = () => {
  if (!fs.existsSync(settingsPath)) {
    console.error('Settings file not found.');
    process.exit(1);
  }

  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const pluginSettings = settings.plugins?.PteroBackup;

  if (!pluginSettings?.enabled) {
    console.log('PteroBackup plugin is not enabled.');
    return;
  }

  // Discord config
  const token = settings.discord.bot.token;
  const channelId = pluginSettings.discord?.channelId;
  const allowedRoleId = pluginSettings.discord?.allowedRoleId;

  if (!token || !channelId || !allowedRoleId) {
    console.error('PteroBackup Discord configuration missing.');
    process.exit(1);
  }

  // Backup paths
  const backupDir = path.resolve(pluginSettings.backup.backupDir);
  const pterodactylServerDir = pluginSettings.backup.pterodactylServerDir;

  // MySQL config
  const mysqlConfig = pluginSettings.database;

  fs.ensureDirSync(backupDir);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  let progressMessage;

  const generateProgressBar = (percent) => {
    const barLength = 40;
    const filledLength = Math.round(percent * barLength);
    const emptyLength = barLength - filledLength;
    return `[${'='.repeat(filledLength)}${' '.repeat(emptyLength)}] ${Math.round(percent * 100)}%`;
  };

  const sendProgressUpdate = async (percent, message) => {
    try {
      const channel = await client.channels.fetch(channelId);
      const progressText = `${message}\n${generateProgressBar(percent)}`;
      if (progressMessage) {
        await progressMessage.edit({ content: progressText });
      } else {
        progressMessage = await channel.send({ content: progressText });
      }
    } catch (error) {
      console.error('Error sending progress update to Discord:', error);
    }
  };

  const sendLogToDiscord = async (message, embed = null) => {
    try {
      const channel = await client.channels.fetch(channelId);
      await channel.send({ content: message, embeds: embed ? [embed] : [] });
    } catch (error) {
      console.error('Error sending log to Discord:', error);
    }
  };

  const calculateSize = async (dir) => {
    try {
      const { default: getFolderSize } = await import('get-folder-size');
      return new Promise((resolve, reject) => {
        getFolderSize(dir, (err, totalSize) => {
          if (err) reject(err);
          else resolve(totalSize);
        });
      });
    } catch (err) {
      throw new Error(`Failed to calculate folder size: ${err.message}`);
    }
  };

  const backupServer = async () => {
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const serverBackupFile = path.join(backupDir, `server_backup_${timestamp}.tar.gz`);
    const dbBackupFile = path.join(backupDir, `database_backup_${timestamp}.sql`);

    await sendProgressUpdate(0, 'Server backup started...');
    const backupCommand = `tar -czf ${serverBackupFile} .`;
    const backupProcess = spawn(backupCommand, [], { cwd: pterodactylServerDir, shell: true });

    let lastSize = 0;
    const interval = setInterval(async () => {
      try {
        if (!fs.existsSync(serverBackupFile)) return;
        const currentSize = fs.statSync(serverBackupFile).size;
        lastSize = currentSize;
        const totalSize = await calculateSize(pterodactylServerDir);
        const progressPercent = Math.min(currentSize / totalSize, 1);
        await sendProgressUpdate(progressPercent, 'Server backup in progress...');
      } catch (err) {
        clearInterval(interval);
        sendLogToDiscord(`Error tracking server backup progress: ${err.message}`);
      }
    }, 10000);

    backupProcess.on('error', (err) => sendLogToDiscord(`Server backup process error: ${err.message}`));
    backupProcess.on('exit', async (code) => {
      clearInterval(interval);
      if (code !== 0) return sendLogToDiscord(`Server backup process exited with code ${code}`);
      await sendProgressUpdate(0.5, 'Server backup completed. Starting database backup...');
      backupDatabase(dbBackupFile, serverBackupFile);
    });
  };

  const backupDatabase = async (dbBackupFile, serverBackupFile) => {
    let connection;
    try {
      connection = await mysql.createConnection(mysqlConfig);
      await sendProgressUpdate(0.5, 'Database backup in progress...');
      const dumpCommand = `mysqldump -u ${mysqlConfig.user} -p${mysqlConfig.password} --host=${mysqlConfig.host} --port=${mysqlConfig.port} ${mysqlConfig.database} > ${dbBackupFile}`;
      const dumpProcess = spawn(dumpCommand, [], { shell: true });

      dumpProcess.on('error', (err) => sendLogToDiscord(`Database backup process error: ${err.message}`));
      dumpProcess.on('exit', () => {
        const serverSize = fs.existsSync(serverBackupFile) ? fs.statSync(serverBackupFile).size / (1024 * 1024) : 0;
        const dbSize = fs.existsSync(dbBackupFile) ? fs.statSync(dbBackupFile).size / (1024 * 1024) : 0;

        const embed = new EmbedBuilder()
          .setTitle('Backup Completed')
          .setColor('#00FF00')
          .addFields(
            { name: 'Server Backup', value: `File: \`${path.basename(serverBackupFile)}\`\nSize: ${serverSize.toFixed(2)} MB` },
            { name: 'Database Backup', value: `File: \`${path.basename(dbBackupFile)}\`\nSize: ${dbSize.toFixed(2)} MB` }
          )
          .setTimestamp();

        sendLogToDiscord('Backup process completed successfully.', embed);
        removeOldBackups();
      });
    } catch (err) {
      sendLogToDiscord(`Database connection error: ${err.message}`);
    } finally {
      if (connection) await connection.end();
    }
  };

  const removeOldBackups = async () => {
    try {
      const files = await fs.readdir(backupDir);
      const serverBackups = files.filter(f => f.startsWith('server_backup_')).sort((a,b) => fs.statSync(path.join(backupDir,b)).mtimeMs - fs.statSync(path.join(backupDir,a)).mtimeMs);
      const dbBackups = files.filter(f => f.startsWith('database_backup_')).sort((a,b) => fs.statSync(path.join(backupDir,b)).mtimeMs - fs.statSync(path.join(backupDir,a)).mtimeMs);

      serverBackups.slice(5).forEach(file => fs.remove(path.join(backupDir,file)));
      dbBackups.slice(5).forEach(file => fs.remove(path.join(backupDir,file)));
    } catch (err) {
      sendLogToDiscord(`Error cleaning old backups: ${err.message}`);
    }
  };

  schedule.scheduleJob('0 */6 * * *', backupServer);

  client.on('messageCreate', async (message) => {
    if (message.content.toLowerCase() === '!backup') {
      if (message.member.roles.cache.has(allowedRoleId)) {
        await sendLogToDiscord('Backup process started manually.');
        await backupServer();
      } else {
        await sendLogToDiscord('You do not have the required role to use this command.');
      }
    }
  });

  const startClient = async () => {
    try {
      await client.login(token);
    } catch (error) {
      console.error('Failed to login to Discord:', error.message);
      process.exit(1);
    }
  };

  startClient();
};
