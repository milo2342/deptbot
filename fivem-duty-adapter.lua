-- WCRP Department Utilities - FiveM duty adapter
--
-- This file does NOT create /duty. It gives you the two database actions
-- your existing /duty script needs to call:
--   StartDuty(source, department)
--   EndDuty(source)
--
-- This example uses oxmysql.

local function normalizeDepartment(department)
    local value = tostring(department or ''):upper():gsub('^%s*(.-)%s*$', '%1')
    if #value < 2 or #value > 15 or not value:match('^[A-Z0-9][A-Z0-9_-]*$') then
        return nil
    end
    return value
end

local function getDiscordId(source)
    for _, identifier in ipairs(GetPlayerIdentifiers(source)) do
        if identifier:sub(1, 8) == 'discord:' then
            return identifier:sub(9)
        end
    end

    return nil
end

function StartDuty(source, department)
    department = normalizeDepartment(department)

    if not department then
        print('[WCRP Duty] Invalid department code.')
        return false
    end

    local discordId = getDiscordId(source)
    if not discordId then
        print(('[WCRP Duty] No Discord identifier found for player %s'):format(source))
        return false
    end

    local existing = MySQL.single.await([[
        SELECT id
        FROM duty_hours
        WHERE discordId = ?
          AND outTime IS NULL
        ORDER BY id DESC
        LIMIT 1
    ]], { discordId })

    if existing then
        return false
    end

    local id = MySQL.insert.await([[
        INSERT INTO duty_hours (discordId, inTime, outTime, department)
        VALUES (?, UNIX_TIMESTAMP(), NULL, ?)
    ]], { discordId, department })

    return id ~= nil
end

function EndDuty(source)
    local discordId = getDiscordId(source)
    if not discordId then
        print(('[WCRP Duty] No Discord identifier found for player %s'):format(source))
        return false
    end

    local affected = MySQL.update.await([[
        UPDATE duty_hours
        SET outTime = UNIX_TIMESTAMP()
        WHERE discordId = ?
          AND outTime IS NULL
        ORDER BY id DESC
        LIMIT 1
    ]], { discordId })

    return affected and affected > 0
end

-- Example integration with your existing /duty code:
--
-- RegisterCommand('duty', function(source)
--     local department = 'USM' -- replace this with your existing department selection
--     local isOnDuty = ...     -- use your existing duty state
--
--     if isOnDuty then
--         EndDuty(source)
--         -- your existing off-duty code here
--     else
--         StartDuty(source, department)
--         -- your existing on-duty code here
--     end
-- end)
