const COMPLAINT_ADMIN_ROLE_ID='1527167132696313866';
export const CONFIG = {
  familyName: "FORBES",
  guildId: process.env.DISCORD_GUILD_ID || process.env.GUILD_ID || "1504699361668497419",
  ownerId: process.env.OWNER_ID || "502825427761365026",

  discordInvite: "https://discord.gg/aPG8DGGGGt",

  // Canonical Discord role IDs. Permission checks must use these IDs.
  roles: {
    bot: "1504883501978095657",             // 🤖 BOT / FORBES BOT
    member: "1504870552152571954",         // Учасник
    boss: "1549814900963016805",
    leader2: "1504871859261538425",
    deputy: "1504871693397790871",
    headCapt: "1504871617543536782",
    depHeadCapt: "1549097790456467660",
    farmManager: "1504871085223706664",
    capper: "1504871411230179359",
    farmer: "1504870952880701592",
    buyout: "1504871275917738066",
    debtor: "1504870592162168843",
    // Backward-compatible aliases for existing code/data. Do not use for new checks.
    newbie: "1504870592162168843", fighter: "1504871275917738066",
    capt: "1504871411230179359", seniorCapt: "1504871617543536782",
    rightHand: "1504871693397790871"
  },

  roleNames: {
    bot: "BOT / FORBES BOT",
    member: "Учасник",
    boss: "BOSS", leader2: "Лідер №2", deputy: "Зам",
    headCapt: "Head Capt", depHeadCapt: "Dep. Head Capt",
    farmManager: "Farm Manager", capper: "Capper", farmer: "Farmer",
    buyout: "Відкуп", debtor: "Боржник"
  },

  // Discord channel IDs you gave me earlier.
  channels: {
    applicationsFamily: "1504856644033450024",
    applicationsFarm: "1504856793757647010",
    applicationsCapt: "1504856875185999883",
    vacations: "1504856936074449046",
    dismissals: "1526079239168725102",
    farmAnnouncements: "1526079568794882129",
    farmReports: "1504857166543327232",
    captReports: "1504874503241732147",
    reportReview: "1504882934468055060",
    salary: "1504882973533536378",
    fullStats: "1504882852704026754",
    botLogs: "1504883368700149891",
    fines: "1504876220410495067",
    finePayments: "1504876287078961334",
    warnings: "1504891515137429677",
    warningRemoval: "1504891603624398968",
    botCommands: "1504883238643044463",
    captSignup: "1505002781847720047",
    captList: "1505002905135218749",
    captReminder: process.env.CAPT_REMINDER_CHANNEL_ID || "1505002988429901935",
    captStats: "1504874503241732147",
    announcements: "1505075081926414377",
    calendar: "1505075126113275944",
    backup: "1504882852704026754",
  blacklist: "1505075615873896488",
    playerCheck: "1505075781494374471",
    giveawayActive: "1505075955247349840",
    giveawayWinners: "1505075996100137110",
    birthdays: "1533936489262747699",
    generalChat: "1504875096484085984",
    seniorFarmMessages: "1504857319907790898",
    seniorCaptMessages: "1504874640705585192",
    chargeReports: "1533952822775779419"
  },

  payout: {
    familyPercent: 25,
    playersPercent: 75,
    maxPlayers: 4,
    weeklyCloseText: "Неділя 20:00"
  },

  capt: {
    listDelayMinutes: 60,
    reminderMinutesBefore: 10
  },

  warnings: {
    days: 7,
    removePrice: 300000,
    kickAt: 3
  }
};
